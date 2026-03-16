#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { extractTokenViaCdp } from "./cdp-extract.js";
import { BrowserContext } from "./reverse-proxy.js";
import { startMcpProxy } from "./proxy.js";

function log(msg: string): void {
  process.stderr.write(`[mattermost-mcp-proxy] ${msg}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.tlsVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    log("TLS certificate verification disabled (set tlsVerify: true to enable)");
  }

  // 1. Extract token from Mattermost client via CDP
  log("Connecting to Mattermost client via CDP...");
  const cdpResult = await extractTokenViaCdp(
    config.mmServerUrl,
    config.cdpPort
  );

  if (!cdpResult) {
    throw new Error(
      "Could not extract token via CDP. Make sure Mattermost client is running with --remote-debugging-port."
    );
  }

  const { accessToken } = cdpResult;
  log(`Token extracted (length: ${accessToken.length}, prefix: ${accessToken.slice(0, 8)}...)`);
  log(`User-Agent: ${cdpResult.userAgent.slice(0, 80)}...`);
  log(`Cookie header length: ${cdpResult.cookieHeader.length}`);

  const browserCtx: BrowserContext = {
    userAgent: cdpResult.userAgent,
    cookieHeader: cdpResult.cookieHeader,
  };

  // 2. Start the official MCP server via reverse proxy
  log("Starting Mattermost MCP server via reverse proxy...");
  const exitCode = await startMcpProxy(config, accessToken, browserCtx);
  process.exit(exitCode);
}

main().catch((err) => {
  log(`Fatal error: ${err.message || err}`);
  process.exit(1);
});
