import { Restrictions } from "./config.js";
import { BrowserContext } from "./reverse-proxy.js";

const log = (msg: string) =>
  process.stderr.write(`[mattermost-mcp-proxy/resolve] ${msg}\n`);

/** Mattermost IDs are 26-char lowercase alphanumeric strings */
const MM_ID_RE = /^[a-z0-9]{26}$/;

/**
 * Resolves human-readable names in restrictions to Mattermost IDs.
 * Values that already look like IDs are kept as-is.
 * Requests go through the reverse proxy to bypass WAF.
 */
export async function resolveRestrictions(
  proxyUrl: string,
  accessToken: string,
  restrictions: Restrictions
): Promise<Restrictions> {
  const resolved: Restrictions = { ...restrictions };

  if (restrictions.allowedChannels?.length) {
    resolved.allowedChannels = await resolveChannels(
      proxyUrl, accessToken, restrictions.allowedChannels
    );
  }

  if (restrictions.allowedUsers?.length) {
    // Keep original usernames for DM tool filtering (dm tool uses username, not user_id)
    resolved.allowedUsernames = restrictions.allowedUsers.filter(u => !MM_ID_RE.test(u));
    resolved.allowedUsers = await resolveUsers(
      proxyUrl, accessToken, restrictions.allowedUsers
    );
    // Also collect resolved usernames for IDs that were already provided as IDs
    const idsWithoutUsername = restrictions.allowedUsers.filter(u => MM_ID_RE.test(u));
    for (const id of idsWithoutUsername) {
      try {
        const user: { username: string } = await apiGet(
          proxyUrl, accessToken, `/api/v4/users/${id}`
        );
        resolved.allowedUsernames.push(user.username);
        log(`Resolved user ID "${id}" → username "${user.username}"`);
      } catch {
        log(`WARNING: Could not resolve user ID "${id}" to username — DM filtering by username may not work for this user`);
      }
    }
  }

  return resolved;
}

async function resolveChannels(
  proxyUrl: string,
  accessToken: string,
  channels: string[]
): Promise<string[]> {
  const result: string[] = [];

  // Pre-fetch teams (needed to resolve channel names)
  let teams: Array<{ id: string; name: string }> = [];
  let teamsFetched = false;

  for (const ch of channels) {
    if (MM_ID_RE.test(ch)) {
      result.push(ch);
      continue;
    }

    // Lazy-load teams list
    if (!teamsFetched) {
      teams = await apiGet(proxyUrl, accessToken, "/api/v4/users/me/teams");
      teamsFetched = true;
    }

    // Try to find channel by name across all user's teams
    let found = false;
    for (const team of teams) {
      try {
        const channel: { id: string } = await apiGet(
          proxyUrl, accessToken,
          `/api/v4/teams/${team.id}/channels/name/${encodeURIComponent(ch)}`
        );
        log(`Resolved channel "${ch}" → ${channel.id} (team: ${team.name})`);
        result.push(channel.id);
        found = true;
        break;
      } catch {
        // Not found in this team, try next
      }
    }

    if (!found) {
      log(`WARNING: Could not resolve channel "${ch}" — skipping`);
    }
  }

  return result;
}

async function resolveUsers(
  proxyUrl: string,
  accessToken: string,
  users: string[]
): Promise<string[]> {
  const result: string[] = [];

  for (const u of users) {
    if (MM_ID_RE.test(u)) {
      result.push(u);
      continue;
    }

    try {
      const user: { id: string } = await apiGet(
        proxyUrl, accessToken,
        `/api/v4/users/username/${encodeURIComponent(u)}`
      );
      log(`Resolved user "${u}" → ${user.id}`);
      result.push(user.id);
    } catch {
      log(`WARNING: Could not resolve user "${u}" — skipping`);
    }
  }

  return result;
}

async function apiGet(proxyUrl: string, token: string, path: string): Promise<any> {
  const resp = await fetch(`${proxyUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`API ${path}: ${resp.status}`);
  }

  return resp.json();
}
