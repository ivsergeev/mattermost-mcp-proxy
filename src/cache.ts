/**
 * Simple in-memory cache for Mattermost API responses.
 * Caches GET requests for entity lookups (users, channels, teams)
 * that rarely change during a session.
 */

const log = (msg: string) =>
  process.stderr.write(`[mattermost-mcp-proxy/cache] ${msg}\n`);

interface CacheEntry {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  cachedAt: number;
}

/** URL patterns eligible for caching (GET only). */
const CACHEABLE_PATTERNS: RegExp[] = [
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

/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ApiCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Check if a request path is eligible for caching. */
  isCacheable(method: string, path: string): boolean {
    if (method !== "GET") return false;
    // Strip query string for matching
    const pathOnly = path.split("?")[0];
    return CACHEABLE_PATTERNS.some((re) => re.test(pathOnly));
  }

  /** Get cached response, or undefined if not cached / expired. */
  get(path: string): CacheEntry | undefined {
    const entry = this.cache.get(path);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(path);
      return undefined;
    }

    return entry;
  }

  /** Store a response in the cache. Only caches successful (2xx) responses. */
  set(path: string, statusCode: number, headers: Record<string, string | string[]>, body: Buffer): void {
    if (statusCode < 200 || statusCode >= 300) return;

    this.cache.set(path, {
      statusCode,
      headers,
      body,
      cachedAt: Date.now(),
    });
    log(`Cached: ${path} (${body.length} bytes, ${this.cache.size} entries total)`);
  }

  /** Number of entries currently in cache. */
  get size(): number {
    return this.cache.size;
  }
}
