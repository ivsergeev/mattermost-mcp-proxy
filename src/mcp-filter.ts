import { Transform, TransformCallback, Writable } from "stream";
import { Restrictions } from "./config.js";

const log = (msg: string) =>
  process.stderr.write(`[mattermost-mcp-proxy/filter] ${msg}\n`);

/**
 * Tracks pending request IDs so we know which responses to filter.
 * Key: JSON-RPC id, Value: method name.
 */
type PendingRequests = Map<string | number, string>;

// Fields commonly containing channel/user IDs in Mattermost MCP tool arguments
const CHANNEL_ID_FIELDS = ["channel_id", "channelId", "channel"];
const USER_ID_FIELDS = ["user_id", "userId", "user"];

// Tools that modify state — subject to channel/user restrictions.
const WRITE_TOOLS = new Set([
  "create_post",
  "create_channel",
  "add_user_to_channel",
  "add_user_to_team",
  "create_post_as_user",
  "create_user",
  "create_team",
]);

// DM tools — use "username" field, checked against allowedUsernames.
// "dm" takes { username, message }, "group_message" takes { usernames: string[], message }.
const DM_TOOL = "dm";
const GROUP_MESSAGE_TOOL = "group_message";

/**
 * Creates a Transform stream that filters MCP client→server messages (requests).
 * - Blocks tools/call for disallowed tools
 * - Blocks tools/call with disallowed channel/user arguments
 *
 * Allowed requests pass through normally.
 * Blocked requests are NOT passed through; instead an error response
 * is written to `clientOut` (which should be process.stdout).
 */
export function createRequestFilter(
  restrictions: Restrictions,
  pending: PendingRequests,
  clientOut: Writable
): Transform {
  let buffer = "";

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      // Keep incomplete last line in buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          this.push("\n");
          continue;
        }

        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          // Not valid JSON — pass through
          this.push(line + "\n");
          continue;
        }

        // Track all requests so we can match responses
        if (msg.method && msg.id !== undefined) {
          pending.set(msg.id, msg.method);
        }

        // Filter tools/call requests
        if (msg.method === "tools/call" && msg.params) {
          const toolName: string = msg.params.name || "";
          const args: Record<string, any> = msg.params.arguments || {};

          // Log every tool call
          log(`Tool call: "${toolName}" args=${JSON.stringify(args)}`);

          // Check allowed tools
          if (restrictions.allowedTools && !restrictions.allowedTools.includes(toolName)) {
            log(`Blocked tool call: "${toolName}" (not in allowedTools)`);
            pending.delete(msg.id);
            clientOut.write(makeBlockedResponse(msg.id, `Tool "${toolName}" is not available`) + "\n");
            continue;
          }

          // Channel/user restrictions for write tools
          if (WRITE_TOOLS.has(toolName)) {
            if (restrictions.allowedChannels) {
              const channelId = findFieldValue(args, CHANNEL_ID_FIELDS);
              if (channelId && !restrictions.allowedChannels.includes(channelId)) {
                log(`Blocked tool call: "${toolName}" targeting channel "${channelId}"`);
                pending.delete(msg.id);
                clientOut.write(makeBlockedResponse(msg.id, `Writing to channel "${channelId}" is not allowed`) + "\n");
                continue;
              }
            }

            if (restrictions.allowedUsers) {
              const userId = findFieldValue(args, USER_ID_FIELDS);
              if (userId && !restrictions.allowedUsers.includes(userId)) {
                log(`Blocked tool call: "${toolName}" targeting user "${userId}"`);
                pending.delete(msg.id);
                clientOut.write(makeBlockedResponse(msg.id, `Actions targeting user "${userId}" are not allowed`) + "\n");
                continue;
              }
            }
          }

          // "dm" tool — check username against allowedUsernames
          if (toolName === DM_TOOL && restrictions.allowedUsernames) {
            const username = typeof args.username === "string" ? args.username : undefined;
            if (username && !restrictions.allowedUsernames.includes(username)) {
              log(`Blocked DM: "${toolName}" targeting username "${username}"`);
              pending.delete(msg.id);
              clientOut.write(makeBlockedResponse(msg.id, `Direct messages to user "${username}" are not allowed`) + "\n");
              continue;
            }
          }

          // "group_message" tool — check all usernames against allowedUsernames
          if (toolName === GROUP_MESSAGE_TOOL && restrictions.allowedUsernames) {
            const usernames: string[] = Array.isArray(args.usernames) ? args.usernames : [];
            const blocked = usernames.filter(u => !restrictions.allowedUsernames!.includes(u));
            if (blocked.length > 0) {
              log(`Blocked group_message: targeting disallowed users: ${blocked.join(", ")}`);
              pending.delete(msg.id);
              clientOut.write(makeBlockedResponse(msg.id, `Group messages to users "${blocked.join(", ")}" are not allowed`) + "\n");
              continue;
            }
          }
        }

        this.push(line + "\n");
      }

      callback();
    },

    flush(callback: TransformCallback) {
      if (buffer.trim()) {
        this.push(buffer + "\n");
      }
      callback();
    },
  });
}

/**
 * Creates a Transform stream that filters MCP server→client messages (responses).
 * - Filters tools/list responses to remove disallowed tools
 */
export function createResponseFilter(
  restrictions: Restrictions,
  pending: PendingRequests
): Transform {
  let buffer = "";

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          this.push("\n");
          continue;
        }

        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          this.push(line + "\n");
          continue;
        }

        // Check if this is a response to a tracked request
        if (msg.id !== undefined && pending.has(msg.id)) {
          const method = pending.get(msg.id)!;
          pending.delete(msg.id);

          // Filter tools/list response
          if (method === "tools/list" && msg.result?.tools && restrictions.allowedTools) {
            const before = msg.result.tools.length;
            msg.result.tools = msg.result.tools.filter(
              (tool: any) => restrictions.allowedTools!.includes(tool.name)
            );
            log(`Filtered tools/list: ${before} → ${msg.result.tools.length} tools`);
            this.push(JSON.stringify(msg) + "\n");
            continue;
          }
        }

        this.push(line + "\n");
      }

      callback();
    },

    flush(callback: TransformCallback) {
      if (buffer.trim()) {
        this.push(buffer + "\n");
      }
      callback();
    },
  });
}

function findFieldValue(args: Record<string, any>, fieldNames: string[]): string | undefined {
  for (const field of fieldNames) {
    if (typeof args[field] === "string") return args[field];
  }
  return undefined;
}

/**
 * Returns a successful MCP tools/call result with isError flag.
 * This way the agent sees it as a tool response (not a protocol error)
 * and understands the action is permanently blocked — no retries needed.
 */
function makeBlockedResponse(id: string | number | null, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: `[BLOCKED] ${message}. This action is restricted by the proxy administrator. Do not retry or attempt workarounds.` }],
      isError: true,
    },
  });
}
