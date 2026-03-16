import { spawn, ChildProcess } from "child_process";
import { Config } from "./config.js";
import { BrowserContext, startReverseProxy } from "./reverse-proxy.js";
import { createRequestFilter, createResponseFilter } from "./mcp-filter.js";
import { resolveRestrictions } from "./resolve.js";

const log = (msg: string) =>
  process.stderr.write(`[mattermost-mcp-proxy/proxy] ${msg}\n`);

/**
 * Starts a local reverse proxy with browser headers, then spawns the
 * official Mattermost MCP server pointing at it. Proxies stdio,
 * optionally filtering MCP messages based on restrictions.
 */
export async function startMcpProxy(
  config: Config,
  accessToken: string,
  browserCtx: BrowserContext
): Promise<number> {
  const proxy = await startReverseProxy(config.mmServerUrl, browserCtx);

  // Resolve human-readable names to IDs before starting the MCP server
  let restrictions = config.restrictions;
  if (restrictions) {
    log("Resolving restriction names to IDs...");
    restrictions = await resolveRestrictions(proxy.localUrl, accessToken, restrictions);
    log(`Resolved restrictions: ${JSON.stringify(restrictions)}`);
  }

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      config.mmMcpServerPath,
      config.mmMcpServerArgs,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MM_ACCESS_TOKEN: accessToken,
          MM_SERVER_URL: proxy.localUrl,
        },
      }
    );

    if (restrictions) {
      const pending = new Map<string | number, string>();

      // Client → requestFilter → MCP server
      // Blocked requests send error responses directly to process.stdout
      const reqFilter = createRequestFilter(restrictions, pending, process.stdout);
      process.stdin.pipe(reqFilter).pipe(child.stdin!);

      // MCP server → responseFilter → Client
      const resFilter = createResponseFilter(restrictions, pending);
      child.stdout!.pipe(resFilter).pipe(process.stdout);
    } else {
      // Direct passthrough (no restrictions configured)
      process.stdin.pipe(child.stdin!);
      child.stdout!.pipe(process.stdout);
    }

    child.stderr!.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.on("error", (err) => {
      proxy.close();
      reject(new Error(`Failed to start MCP server: ${err.message}`));
    });

    child.on("exit", (code) => {
      proxy.close();
      resolve(code ?? 1);
    });

    const cleanup = () => {
      if (!child.killed) child.kill();
      proxy.close();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", cleanup);
  });
}
