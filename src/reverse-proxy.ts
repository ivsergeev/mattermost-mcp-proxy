import * as http from "http";
import * as https from "https";

export interface BrowserContext {
  /** User-Agent string from the real browser */
  userAgent: string;
  /** All cookies for the Mattermost domain (name=value pairs joined with "; ") */
  cookieHeader: string;
}

/**
 * Starts a local HTTP reverse proxy that forwards requests to the real
 * Mattermost server, injecting browser-like headers to bypass antibot/WAF.
 *
 * Returns the local URL (http://127.0.0.1:<port>) to give to the MCP server.
 */
export function startReverseProxy(
  targetUrl: string,
  browserCtx: BrowserContext
): Promise<{ localUrl: string; close: () => void }> {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === "https:";

  const log = (msg: string) =>
    process.stderr.write(`[mattermost-mcp-proxy/reverse-proxy] ${msg}\n`);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = req.url || "/";

      // Build headers: start from incoming, override with browser-like values
      const headers: Record<string, string> = {};
      // Copy original headers (lowercase)
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

      // Remove hop-by-hop headers that shouldn't be forwarded
      delete headers["connection"];
      delete headers["keep-alive"];

      const options: https.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: reqUrl,
        method: req.method,
        headers,
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
      };

      const transport = isHttps ? https : http;
      const proxyReq = transport.request(
        options,
        (proxyRes) => {
          // Remove Set-Cookie from responses (the MCP server doesn't need to track cookies)
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders["set-cookie"];

          res.writeHead(proxyRes.statusCode || 502, respHeaders);
          proxyRes.pipe(res, { end: true });
        }
      );

      proxyReq.on("error", (err) => {
        log(`Proxy request error: ${err.message}`);
        res.writeHead(502);
        res.end("Bad Gateway");
      });

      req.pipe(proxyReq, { end: true });
    });

    server.on("error", reject);

    // Listen on random port on loopback
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
