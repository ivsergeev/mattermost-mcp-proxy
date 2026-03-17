import * as http from "http";
import * as https from "https";
import { ApiCache } from "./cache.js";

export interface BrowserContext {
  /** User-Agent string from the real browser */
  userAgent: string;
  /** All cookies for the Mattermost domain (name=value pairs joined with "; ") */
  cookieHeader: string;
}

/**
 * Starts a local HTTP reverse proxy that forwards requests to the real
 * Mattermost server, injecting browser-like headers to bypass antibot/WAF.
 * Includes in-memory caching for entity lookup GET requests and stable
 * POST search endpoints (users, channels).
 *
 * Returns the local URL (http://127.0.0.1:<port>) to give to the MCP server.
 */
export function startReverseProxy(
  targetUrl: string,
  browserCtx: BrowserContext,
  cacheTtlMs?: number
): Promise<{ localUrl: string; close: () => void }> {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === "https:";
  const cache = new ApiCache(cacheTtlMs);

  const log = (msg: string) =>
    process.stderr.write(`[mattermost-mcp-proxy/reverse-proxy] ${msg}\n`);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = req.url || "/";
      const method = req.method || "GET";

      // Check cache for eligible GET requests (no body needed)
      if (method === "GET" && cache.isCacheableGet(reqUrl)) {
        const cached = cache.get(reqUrl);
        if (cached) {
          log(`Cache HIT: ${reqUrl}`);
          res.writeHead(cached.statusCode, cached.headers);
          res.end(cached.body);
          return;
        }
      }

      // For POST requests that might be cacheable, we need the body first
      const isCacheablePost = method === "POST" && cache.isCacheablePost(reqUrl);

      if (isCacheablePost) {
        // Buffer request body to compute cache key
        const reqChunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => reqChunks.push(chunk));
        req.on("end", () => {
          const reqBody = Buffer.concat(reqChunks);
          const cacheKey = cache.postKey(reqUrl, reqBody);

          // Check cache
          const cached = cache.get(cacheKey);
          if (cached) {
            log(`Cache HIT: POST ${reqUrl}`);
            res.writeHead(cached.statusCode, cached.headers);
            res.end(cached.body);
            return;
          }

          // Cache miss — forward with buffered body
          forwardRequest(req, res, reqUrl, method, true, cacheKey, reqBody);
        });
      } else {
        const shouldCache = method === "GET" && cache.isCacheableGet(reqUrl);
        forwardRequest(req, res, reqUrl, method, shouldCache, reqUrl, null);
      }

      function forwardRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        reqUrl: string,
        method: string,
        shouldCache: boolean,
        cacheKey: string,
        bufferedBody: Buffer | null
      ) {
        // Build headers: start from incoming, override with browser-like values
        const headers: Record<string, string> = {};
        for (const [key, val] of Object.entries(req.headers)) {
          if (val) headers[key] = Array.isArray(val) ? val.join(", ") : val;
        }

        // Override with browser context
        headers["user-agent"] = browserCtx.userAgent;
        headers["cookie"] = browserCtx.cookieHeader;
        headers["host"] = target.host;

        // Add typical browser headers if missing
        headers["accept-language"] ??= "en-US,en;q=0.9,ru;q=0.8";
        headers["accept-encoding"] ??= "gzip, deflate, br";
        headers["x-requested-with"] ??= "XMLHttpRequest";

        // Remove hop-by-hop headers
        delete headers["connection"];
        delete headers["keep-alive"];

        // Disable compression for cacheable requests so we store plain text
        if (shouldCache) {
          delete headers["accept-encoding"];
        }

        const options: https.RequestOptions = {
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: reqUrl,
          method,
          headers,
          rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
        };

        const transport = isHttps ? https : http;
        const proxyReq = transport.request(options, (proxyRes) => {
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders["set-cookie"];

          if (shouldCache) {
            const chunks: Buffer[] = [];
            proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
            proxyRes.on("end", () => {
              const body = Buffer.concat(chunks);
              cache.set(cacheKey, proxyRes.statusCode || 502, respHeaders as Record<string, string | string[]>, body);
              res.writeHead(proxyRes.statusCode || 502, respHeaders);
              res.end(body);
            });
          } else {
            res.writeHead(proxyRes.statusCode || 502, respHeaders);
            proxyRes.pipe(res, { end: true });
          }
        });

        proxyReq.on("error", (err) => {
          log(`Proxy request error: ${err.message}`);
          res.writeHead(502);
          res.end("Bad Gateway");
        });

        if (bufferedBody) {
          // Body already buffered — write it directly
          proxyReq.end(bufferedBody);
        } else {
          // Stream body from client
          req.pipe(proxyReq, { end: true });
        }
      }
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const localUrl = `http://127.0.0.1:${addr.port}`;
      log(`Reverse proxy listening on ${localUrl} → ${targetUrl}`);
      resolve({
        localUrl,
        close: () => server.close(),
      });
    });
  });
}
