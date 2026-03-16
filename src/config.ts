import * as fs from "fs";
import * as path from "path";

export interface Restrictions {
  /** If set, only these tools will be exposed to the MCP client */
  allowedTools?: string[];
  /** If set, only posts/actions targeting these channel IDs are allowed */
  allowedChannels?: string[];
  /** If set, only actions targeting these user IDs are allowed */
  allowedUsers?: string[];
  /** Original usernames from config (before resolution to IDs). Populated by resolve.ts */
  allowedUsernames?: string[];
}

export interface Config {
  /** Mattermost server URL (e.g. https://mattermost.example.com) */
  mmServerUrl: string;
  /** Path to the official Mattermost MCP server binary */
  mmMcpServerPath: string;
  /** Additional args to pass to the MCP server */
  mmMcpServerArgs: string[];
  /** CDP remote debugging port (default: 9222) */
  cdpPort?: number;
  /** Verify TLS certificates (default: false for corporate self-signed certs) */
  tlsVerify: boolean;
  /** Optional restrictions to limit agent capabilities */
  restrictions?: Restrictions;
}

export function loadConfig(): Config {
  const configPath =
    process.env.MCP_PROXY_CONFIG ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".mattermost-mcp-proxy.json"
    );

  let fileConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  const get = (envKey: string, fileKey: string, fallback?: string): string => {
    const value =
      process.env[envKey] || (fileConfig[fileKey] as string) || fallback;
    if (!value) {
      throw new Error(
        `Missing required config: set ${envKey} env var or "${fileKey}" in ${configPath}`
      );
    }
    return value;
  };

  return {
    mmServerUrl: get("MM_SERVER_URL", "serverUrl").replace(/\/+$/, ""),
    mmMcpServerPath: get("MM_MCP_SERVER_PATH", "mcpServerPath"),
    mmMcpServerArgs:
      process.env.MM_MCP_SERVER_ARGS?.split(" ") ||
      (fileConfig.mcpServerArgs as string[]) ||
      [],
    cdpPort:
      process.env.MM_CDP_PORT ? parseInt(process.env.MM_CDP_PORT, 10) :
      (fileConfig.cdpPort as number) || undefined,
    tlsVerify:
      process.env.MM_TLS_VERIFY !== undefined
        ? process.env.MM_TLS_VERIFY === "1" || process.env.MM_TLS_VERIFY === "true"
        : (fileConfig.tlsVerify as boolean) ?? false,
    restrictions: (fileConfig.restrictions as Restrictions) || undefined,
  };
}
