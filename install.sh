#!/usr/bin/env bash
# Fix Windows line endings if the script was cloned on Windows
if [[ "$(head -1 "$0" | od -An -tx1 | tr -d ' ')" == *"0d0a"* ]]; then
  exec bash <(sed 's/\r$//' "$0") "$@"
fi
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# Install script for mattermost-mcp-proxy
# Extracts auth token from Mattermost client via CDP
# Installs: Node.js, Go, official Mattermost MCP server, proxy
# ──────────────────────────────────────────────────────────────

INSTALL_DIR="${INSTALL_DIR:-/opt/mattermost-mcp-proxy}"
MM_MCP_REPO="https://github.com/mattermost/mattermost-plugin-agents.git"
MM_MCP_BRANCH="master"
# Pinned commit for reproducible builds. Update this to upgrade mattermost-mcp-server.
MM_MCP_COMMIT="46a4f9a8262369965d9054931f7274f69b070219"
GO_VERSION="1.24.1"
NODE_MAJOR=22
CDP_PORT=9222

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Preflight ─────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
fi

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~$REAL_USER")

# ── 1. System dependencies ───────────────────────────────────
log "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg > /dev/null

# ── 2. Node.js ────────────────────────────────────────────────
if command -v node &> /dev/null && [[ "$(node -v | cut -d. -f1 | tr -d v)" -ge "$NODE_MAJOR" ]]; then
  log "Node.js $(node -v) already installed, skipping."
else
  log "Installing Node.js ${NODE_MAJOR}.x..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs > /dev/null
  log "Node.js $(node -v) installed."
fi

# ── 3. Go ─────────────────────────────────────────────────────
GO_INSTALLED=false
if command -v go &> /dev/null; then
  CURRENT_GO=$(go version | grep -oP '\d+\.\d+\.\d+')
  if [[ "$(printf '%s\n' "$GO_VERSION" "$CURRENT_GO" | sort -V | head -n1)" == "$GO_VERSION" ]]; then
    log "Go ${CURRENT_GO} already installed, skipping."
    GO_INSTALLED=true
  fi
fi

if [[ "$GO_INSTALLED" == false ]]; then
  log "Installing Go ${GO_VERSION}..."
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  export PATH="/usr/local/go/bin:$PATH"
  log "Go $(go version | grep -oP '\d+\.\d+\.\d+') installed."
fi

export PATH="/usr/local/go/bin:$PATH"

# ── 4. Build official Mattermost MCP server ───────────────────
MM_MCP_BIN="/usr/local/bin/mattermost-mcp-server"

if [[ -f "$MM_MCP_BIN" ]]; then
  log "Mattermost MCP server binary already exists at ${MM_MCP_BIN}, skipping build."
else
  log "Cloning mattermost-plugin-agents repository (commit ${MM_MCP_COMMIT:0:12})..."
  MM_BUILD_DIR=$(mktemp -d)
  git clone "$MM_MCP_REPO" "$MM_BUILD_DIR" -b "$MM_MCP_BRANCH" 2>/dev/null
  cd "$MM_BUILD_DIR"
  git checkout "$MM_MCP_COMMIT" 2>/dev/null

  log "Building Mattermost MCP server (this may take a few minutes)..."
  if [[ -f "mcpserver/cmd/main.go" ]]; then
    go build -o "$MM_MCP_BIN" ./mcpserver/cmd/main.go 2>&1
  else
    warn "MCP server source not found at mcpserver/cmd/main.go"
    warn "Build it manually: https://github.com/mattermost/mattermost-plugin-agents"
    warn "Then set mcpServerPath in ~/.mattermost-mcp-proxy.json"
  fi
  cd /
  rm -rf "$MM_BUILD_DIR"

  if [[ -f "$MM_MCP_BIN" ]]; then
    chmod +x "$MM_MCP_BIN"
    log "Mattermost MCP server installed at ${MM_MCP_BIN}"
  fi
fi

# ── 5. Install mattermost-mcp-proxy ──────────────────────────
log "Installing mattermost-mcp-proxy to ${INSTALL_DIR}..."

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR"/package.json "$SCRIPT_DIR"/tsconfig.json "$INSTALL_DIR"/
cp -r "$SCRIPT_DIR"/src "$INSTALL_DIR"/

cd "$INSTALL_DIR"

npm install 2>/dev/null
npm run build 2>/dev/null

# No runtime dependencies — remove build artifacts
rm -rf node_modules src tsconfig.json package-lock.json

# Create wrapper script
cat > /usr/local/bin/mattermost-mcp-proxy << WRAPPER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/dist/index.js" "\$@"
WRAPPER
chmod +x /usr/local/bin/mattermost-mcp-proxy

log "mattermost-mcp-proxy installed."

# ── 6. Create config template ─────────────────────────────────
CONFIG_PATH="${REAL_HOME}/.mattermost-mcp-proxy.json"

if [[ ! -f "$CONFIG_PATH" ]]; then
  log "Creating config template at ${CONFIG_PATH}..."
  cat > "$CONFIG_PATH" << CONF
{
  "serverUrl": "https://mattermost.example.com",
  "mcpServerPath": "/usr/local/bin/mattermost-mcp-server",
  "cdpPort": ${CDP_PORT},
  "restrictions": {
    "allowedTools": [
      "read_post", "read_channel", "search_posts",
      "get_channel_info", "get_channel_members",
      "get_team_info", "get_team_members", "search_users",
      "create_post"
    ],
    "allowedChannels": [],
    "allowedUsers": []
  }
}
CONF
  chown "$REAL_USER:$REAL_USER" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  warn "Edit ${CONFIG_PATH} with your Mattermost server URL."
else
  log "Config already exists at ${CONFIG_PATH}, not overwriting."
fi

# ── 7. Summary ────────────────────────────────────────────────
echo ""
log "Installation complete!"
echo ""
echo "  How it works:"
echo "    The proxy connects to the Mattermost client via Chrome DevTools Protocol"
echo "    (CDP) to extract the auth token — no cookie files or decryption needed."
echo ""
echo "  Prerequisites:"
echo "    - Mattermost client must be running with --remote-debugging-port=${CDP_PORT}"
echo "    - You must be logged in"
echo ""
echo "  Next steps:"
echo "  1. Edit your config with the Mattermost server URL:"
echo "     ${CONFIG_PATH}"
echo ""
echo "  2. Make sure the Mattermost client is started with --remote-debugging-port=${CDP_PORT}"
echo ""
echo "  3. Add to opencode (opencode.json):"
echo "     {\"mcp\": {\"mattermost\": {"
echo "       \"type\": \"local\","
echo "       \"command\": [\"mattermost-mcp-proxy\"]"
echo "     }}}"
echo ""
echo "  Or run directly: mattermost-mcp-proxy"
