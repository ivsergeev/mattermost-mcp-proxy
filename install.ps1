#Requires -RunAsAdministrator
# ──────────────────────────────────────────────────────────────
# Install script for mattermost-mcp-proxy (Windows)
# Extracts auth token from Mattermost client via CDP
# Installs: Node.js, Go, official Mattermost MCP server, proxy
# ──────────────────────────────────────────────────────────────

param(
    [string]$InstallDir = "$env:ProgramFiles\mattermost-mcp-proxy",
    [int]$CdpPort = 9222
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$MM_MCP_REPO    = "https://github.com/mattermost/mattermost-plugin-agents.git"
$MM_MCP_BRANCH  = "master"
# Pinned commit for reproducible builds. Update this to upgrade mattermost-mcp-server.
$MM_MCP_COMMIT  = "46a4f9a8262369965d9054931f7274f69b070219"
$GO_VERSION     = "1.24.1"
$NODE_MAJOR     = 22

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ── Helpers ──────────────────────────────────────────────────

function Log   ($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Error ($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

function Test-Command ($cmd) {
    $null = Get-Command $cmd -ErrorAction SilentlyContinue
    return $?
}

function Refresh-Path {
    # Re-read PATH from the registry so newly installed tools are visible
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = "$machinePath;$userPath"
}

function Invoke-Native {
    <#
    .SYNOPSIS
    Runs a native command completely outside PowerShell's error handling.
    Uses Start-Process + cmd /c so PowerShell never sees stderr at all.
    Output is captured to a temp file, displayed, and included in the
    exception on failure.
    #>
    param(
        [Parameter(Mandatory)][string]$Command,
        [string]$Description = "Native command"
    )
    $outFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "$Command 2>&1" `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $outFile `
            -WorkingDirectory (Get-Location).Path

        # Show output to console
        if (Test-Path $outFile) {
            $content = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
            if ($content) { Write-Host $content }
        }

        if ($proc.ExitCode -ne 0) {
            $tail = ""
            if (Test-Path $outFile) {
                $tail = (Get-Content $outFile -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
            }
            throw "$Description failed (exit code $($proc.ExitCode)):`n$tail"
        }
    } finally {
        Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    }
}

# ── 1. Check git ─────────────────────────────────────────────

if (-not (Test-Command "git")) {
    Error "Git is required but not found. Install from https://git-scm.com/"
}

# ── 2. Node.js ───────────────────────────────────────────────

$nodeOk = $false
if (Test-Command "node") {
    $nodeVer = (node -v) -replace '^v',''
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge $NODE_MAJOR) {
        Log "Node.js v$nodeVer already installed, skipping."
        $nodeOk = $true
    }
}

if (-not $nodeOk) {
    Log "Installing Node.js ${NODE_MAJOR}.x via winget..."
    if (Test-Command "winget") {
        Invoke-Native "winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements" "winget install Node.js"
        Refresh-Path
        # winget may not update PATH in time — add the default Node.js location explicitly
        $defaultNodeDir = "$env:ProgramFiles\nodejs"
        if ((Test-Path $defaultNodeDir) -and ($env:Path -notlike "*$defaultNodeDir*")) {
            $env:Path = "$defaultNodeDir;$env:Path"
        }
        if (Test-Command "node") {
            Log "Node.js $(node -v) installed."
        } else {
            Error "Node.js installation via winget failed. Install manually from https://nodejs.org/"
        }
    } else {
        Error "Node.js >= $NODE_MAJOR is required. Install from https://nodejs.org/"
    }
}

# ── 3. Go ────────────────────────────────────────────────────

$goOk = $false
if (Test-Command "go") {
    $goVer = ((go version) -replace '.*go(\d+\.\d+\.\d+).*','$1')
    if ([version]$goVer -ge [version]$GO_VERSION) {
        Log "Go $goVer already installed, skipping."
        $goOk = $true
    }
}

if (-not $goOk) {
    Log "Installing Go ${GO_VERSION} via winget..."
    if (Test-Command "winget") {
        Invoke-Native "winget install --id GoLang.Go --accept-source-agreements --accept-package-agreements" "winget install Go"
        Refresh-Path
        # winget may not update PATH in time — add the default Go location explicitly
        $defaultGoBin = "$env:ProgramFiles\Go\bin"
        if ((Test-Path $defaultGoBin) -and ($env:Path -notlike "*$defaultGoBin*")) {
            $env:Path = "$defaultGoBin;$env:Path"
        }
        if (Test-Command "go") {
            Log "Go $((go version) -replace '.*go(\d+\.\d+\.\d+).*','$1') installed."
        } else {
            Error "Go installation via winget failed. Install manually from https://go.dev/dl/"
        }
    } else {
        Error "Go >= $GO_VERSION is required. Install from https://go.dev/dl/"
    }
}

# ── 4. Build official Mattermost MCP server ──────────────────

$MM_MCP_BIN = "$env:ProgramFiles\mattermost-mcp-server\mattermost-mcp-server.exe"

if (Test-Path $MM_MCP_BIN) {
    Log "Mattermost MCP server binary already exists at $MM_MCP_BIN, skipping build."
} else {
    # Resolve TEMP to long path — $env:TEMP may contain 8.3 short names
    # (e.g. C:\Users\75BD~1\...) which Push-Location cannot resolve.
    $tempDir  = (Get-Item $env:TEMP).FullName
    $buildDir = Join-Path $tempDir "mm-mcp-build-$(Get-Random)"
    Log "Cloning mattermost-plugin-agents repository (commit $($MM_MCP_COMMIT.Substring(0,12)))..."
    Invoke-Native "git clone `"$MM_MCP_REPO`" `"$buildDir`" -b $MM_MCP_BRANCH" "git clone"
    Push-Location $buildDir
    Invoke-Native "git checkout $MM_MCP_COMMIT" "git checkout"

    $mainGo = Join-Path $buildDir "mcpserver\cmd\main.go"
    if (Test-Path $mainGo) {
        Log "Building Mattermost MCP server (this may take a few minutes)..."
        # Ensure GOPATH exists for freshly installed Go
        if (-not $env:GOPATH) {
            $env:GOPATH = Join-Path $env:USERPROFILE "go"
        }
        if (-not (Test-Path $env:GOPATH)) {
            New-Item -ItemType Directory -Path $env:GOPATH -Force | Out-Null
        }
        $binDir = Split-Path $MM_MCP_BIN -Parent
        if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
        Log "Running: go build -o $MM_MCP_BIN ./mcpserver/cmd/main.go"
        Invoke-Native "go build -o `"$MM_MCP_BIN`" ./mcpserver/cmd/main.go" "go build"
        if (Test-Path $MM_MCP_BIN) {
            Log "Mattermost MCP server installed at $MM_MCP_BIN"
        }
    } else {
        Warn "MCP server source not found at mcpserver/cmd/main.go"
        Warn "Build it manually: https://github.com/mattermost/mattermost-plugin-agents"
        Warn "Then set mcpServerPath in config."
    }

    Pop-Location
    Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
}

# ── 5. Install mattermost-mcp-proxy ─────────────────────────

Log "Installing mattermost-mcp-proxy to $InstallDir..."

if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }

Copy-Item (Join-Path $ScriptDir "package.json")  $InstallDir -Force
Copy-Item (Join-Path $ScriptDir "tsconfig.json") $InstallDir -Force
Copy-Item (Join-Path $ScriptDir "src") $InstallDir -Recurse -Force

Push-Location $InstallDir
Invoke-Native "npm install" "npm install"
Invoke-Native "npm run build" "npm run build"
Pop-Location

# No runtime dependencies - remove build artifacts
Remove-Item -Recurse -Force (Join-Path $InstallDir "node_modules") -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $InstallDir "src")          -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $InstallDir "tsconfig.json")         -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $InstallDir "package-lock.json")     -ErrorAction SilentlyContinue

# Create wrapper batch file in a PATH-accessible location
$wrapperDir = "$env:ProgramFiles\mattermost-mcp-proxy\bin"
if (-not (Test-Path $wrapperDir)) { New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null }

$wrapperPath = Join-Path $wrapperDir "mattermost-mcp-proxy.cmd"
Set-Content -Path $wrapperPath -Value "@echo off`r`nnode `"$InstallDir\dist\index.js`" %*"

# Add to system PATH if not already there
$systemPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($systemPath -notlike "*$wrapperDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$systemPath;$wrapperDir", "Machine")
    $env:Path = "$env:Path;$wrapperDir"
    Log "Added $wrapperDir to system PATH."
}

Log "mattermost-mcp-proxy installed."

# ── 6. Create config template ────────────────────────────────

$ConfigPath = Join-Path $env:USERPROFILE ".mattermost-mcp-proxy.json"

if (-not (Test-Path $ConfigPath)) {
    Log "Creating config template at $ConfigPath..."
    $configContent = @"
{
  "serverUrl": "https://mattermost.example.com",
  "mcpServerPath": "$($MM_MCP_BIN -replace '\\','\\')",
  "cdpPort": $CdpPort,
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
"@
    Set-Content -Path $ConfigPath -Value $configContent -Encoding UTF8
    Warn "Edit $ConfigPath with your Mattermost server URL."
} else {
    Log "Config already exists at $ConfigPath, not overwriting."
}

# ── 7. Summary ───────────────────────────────────────────────

Write-Host ""
Log "Installation complete!"
Write-Host ""
Write-Host "  How it works:"
Write-Host "    The proxy connects to the Mattermost client via Chrome DevTools Protocol"
Write-Host "    (CDP) to extract the auth token - no cookie files or decryption needed."
Write-Host ""
Write-Host "  Prerequisites:"
Write-Host "    - Mattermost client must be running with --remote-debugging-port=$CdpPort"
Write-Host "    - You must be logged in"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "  1. Edit your config with the Mattermost server URL:"
Write-Host "     $ConfigPath"
Write-Host ""
Write-Host "  2. Start Mattermost client with CDP enabled:"
Write-Host "     & `"$env:LOCALAPPDATA\Programs\mattermost-desktop\Mattermost.exe`" --remote-debugging-port=$CdpPort"
Write-Host ""
Write-Host "  3. Add to opencode (opencode.json):"
Write-Host '     {"mcp": {"mattermost": {'
Write-Host '       "type": "local",'
Write-Host '       "command": ["mattermost-mcp-proxy"]'
Write-Host '     }}}'
Write-Host ""
Write-Host "  Or add to Claude Code (.claude/settings.local.json):"
Write-Host '     {"mcpServers": {"mattermost": {'
Write-Host '       "command": "mattermost-mcp-proxy",'
Write-Host '       "args": []'
Write-Host '     }}}'
Write-Host ""
Write-Host "  Or run directly: mattermost-mcp-proxy"
