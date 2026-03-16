const CDP_TIMEOUT = 5000;
const DEFAULT_CDP_PORT = 9222;

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface CdpExtractResult {
  /** The MMAUTHTOKEN value */
  accessToken: string;
  /** User-Agent string from the browser */
  userAgent: string;
  /** All cookies for the Mattermost domain as "name=value; name2=value2" */
  cookieHeader: string;
}

/**
 * Extracts MMAUTHTOKEN, User-Agent, and domain cookies from a running
 * Mattermost client via Chrome DevTools Protocol.
 * The client must be started with --remote-debugging-port=PORT.
 */
export async function extractTokenViaCdp(
  mmServerHost: string,
  cdpPort?: number
): Promise<CdpExtractResult | null> {
  const port = cdpPort || DEFAULT_CDP_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. List available targets
    const targetsResp = await fetchWithTimeout(`${baseUrl}/json`, CDP_TIMEOUT);
    if (!targetsResp.ok) return null;
    const targets = await targetsResp.json() as Array<{
      webSocketDebuggerUrl?: string;
      url?: string;
      type?: string;
    }>;

    // 2. Find a page target (preferably one with the Mattermost URL)
    const host = mmServerHost
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "");

    let target = targets.find(
      (t) => t.type === "page" && t.url && t.url.includes(host)
    );
    if (!target) {
      target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    }
    if (!target?.webSocketDebuggerUrl) return null;

    // 3. Connect via WebSocket and get all cookies + User-Agent
    const { cookies, userAgent } = await getBrowserContextViaCdp(
      target.webSocketDebuggerUrl
    );

    // 4. Find MMAUTHTOKEN
    const mmCookie = cookies.find(
      (c) => c.name === "MMAUTHTOKEN" && c.domain.includes(host)
    );
    const token = mmCookie?.value
      || cookies.find((c) => c.name === "MMAUTHTOKEN")?.value;
    if (!token) return null;

    // 5. Build cookie header for the domain
    const domainCookies = cookies
      .filter((c) => c.domain.includes(host) || host.includes(c.domain.replace(/^\./, "")))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    return {
      accessToken: token,
      userAgent,
      cookieHeader: domainCookies || `MMAUTHTOKEN=${token}`,
    };
  } catch {
    return null;
  }
}

/**
 * Connect to a CDP WebSocket endpoint, get all cookies and the User-Agent.
 */
function getBrowserContextViaCdp(
  wsUrl: string
): Promise<{ cookies: CdpCookie[]; userAgent: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let cookies: CdpCookie[] | null = null;
    let userAgent: string | null = null;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP WebSocket timeout"));
    }, CDP_TIMEOUT);

    const tryResolve = () => {
      if (cookies !== null && userAgent !== null) {
        clearTimeout(timer);
        ws.close();
        resolve({ cookies, userAgent });
      }
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
      ws.send(
        JSON.stringify({
          id: 2,
          method: "Runtime.evaluate",
          params: { expression: "navigator.userAgent" },
        })
      );
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.id === 1) {
          cookies = data.result?.cookies || [];
          tryResolve();
        } else if (data.id === 2) {
          userAgent = data.result?.result?.value || "";
          tryResolve();
        }
      } catch {
        clearTimeout(timer);
        ws.close();
        reject(new Error("Failed to parse CDP response"));
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function fetchWithTimeout(url: string, timeout: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
