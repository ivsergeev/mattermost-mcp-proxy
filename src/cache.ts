/**
 * Simple in-memory cache for Mattermost API responses.
 * Caches GET requests for entity lookups and POST requests for
 * stable search endpoints (users, channels).
 */

import * as crypto from "crypto";

const log = (msg: string) =>
  process.stderr.write(`[mattermost-mcp-proxy/cache] ${msg}\n`);

interface CacheEntry {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  cachedAt: number;
}

/** GET URL patterns eligible for caching. */
const CACHEABLE_GET_PATTERNS: RegExp[] = [
  // User by ID: /api/v4/users/{id}
  /^\/api\/v4\/users\/[a-z0-9]{26}$/,
  // User by username: /api/v4/users/username/{username}
  /^\/api\/v4\/users\/username\/[^/]+$/,
  // Channel by name: /api/v4/teams/{id}/channels/name/{name}
  /^\/api\/v4\/teams\/[a-z0-9]{26}\/channels\/name\/[^/]+$/,
  // Channel by ID: /api/v4/channels/{id}
  /^\/api\/v4\/channels\/[a-z0-9]{26}$/,
  // Team by ID: /api/v4/teams/{id}
  /^\/api\/v4\/teams\/[a-z0-9]{26}$/,
  // Current user's teams: /api/v4/users/me/teams
  /^\/api\/v4\/users\/me\/teams$/,
  // Current user info: /api/v4/users/me
  /^\/api\/v4\/users\/me$/,
  // Channel members (small, frequently re-fetched): /api/v4/channels/{id}/members
  /^\/api\/v4\/channels\/[a-z0-9]{26}\/members/,
];

/** POST URL patterns eligible for caching (stable search endpoints). */
const CACHEABLE_POST_PATTERNS: RegExp[] = [
  // Search users: POST /api/v4/users/search
  /^\/api\/v4\/users\/search$/,
  // Autocomplete users: POST /api/v4/users/autocomplete
  /^\/api\/v4\/users\/autocomplete$/,
  // Search channels: POST /api/v4/teams/{id}/channels/search
  /^\/api\/v4\/teams\/[a-z0-9]{26}\/channels\/search$/,
  // Search channels (all teams): POST /api/v4/channels/search
  /^\/api\/v4\/channels\/search$/,
  // Get users by IDs: POST /api/v4/users/ids
  /^\/api\/v4\/users\/ids$/,
  // Get users by usernames: POST /api/v4/users/usernames
  /^\/api\/v4\/users\/usernames$/,
  // Get channels by IDs: POST /api/v4/channels/ids
  /^\/api\/v4\/channels\/ids$/,
];

/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ApiCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private disabled: boolean;

  constructor(ttlMs?: number) {
    this.disabled = ttlMs === 0;
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Check if a GET request path is eligible for caching. */
  isCacheableGet(path: string): boolean {
    if (this.disabled) return false;
    const pathOnly = path.split("?")[0];
    return CACHEABLE_GET_PATTERNS.some((re) => re.test(pathOnly));
  }

  /** Check if a POST request path is eligible for caching. */
  isCacheablePost(path: string): boolean {
    if (this.disabled) return false;
    const pathOnly = path.split("?")[0];
    return CACHEABLE_POST_PATTERNS.some((re) => re.test(pathOnly));
  }

  /** Build cache key for POST requests: path + hash of request body. */
  postKey(path: string, body: Buffer): string {
    const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
    return `POST:${path}:${hash}`;
  }

  /** Get cached response, or undefined if not cached / expired. */
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  /** Store a response in the cache. Only caches successful (2xx) responses. */
  set(key: string, statusCode: number, headers: Record<string, string | string[]>, body: Buffer): void {
    if (statusCode < 200 || statusCode >= 300) return;

    this.cache.set(key, {
      statusCode,
      headers,
      body,
      cachedAt: Date.now(),
    });
    log(`Cached: ${key} (${body.length} bytes, ${this.cache.size} entries total)`);
  }

  /** Number of entries currently in cache. */
  get size(): number {
    return this.cache.size;
  }
}
