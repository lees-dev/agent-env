# cpa preflight (read-only), dot-sourced by scripts/preflight.ps1. Windows PowerShell 5.1, ASCII only.
#
# Every machine: the management API is not reachable through the hub URL, and plaintext key
# files left by the old wiring (counted, never opened).
# Hub only: the CPA install directory, loopback-only binds and allow-remote=false (each file is
# matched in memory and only OK/FAIL is printed), the tailscale serve mount (/v1 only, no Funnel),
# the tag:cpa-hub tag, and Python for the ~/.cpa-tools scripts.
# Sends no key. Never exits. Variables: $Repo $Versions $Role $Machine $Vault $CpaUrl.

function Cpa-Code {
    param([string]$url, [int]$timeout = 8)
    $c = & curl.exe -sS -o NUL -w '%{http_code}' --max-time $timeout $url 2>$null
    if (-not $c) { return '000' }
    return [string]$c
}

$cpaCurl = [bool](Get-Command 'curl.exe' -ErrorAction SilentlyContinue)
if ($cpaCurl -and $CpaUrl.StartsWith('https://')) {
    # Requests through tailscale serve reach CPA from 127.0.0.1, so allow-remote=false would not
    # stop them: only a /v1-only mount keeps the management API off the tailnet.
    $cpaM = Cpa-Code "$CpaUrl/v8/management/config"
    if ($cpaM -eq '404') { Ae-Ok "management API not served at $CpaUrl (HTTP 404)" }
    elseif ($cpaM -eq '000') { Ae-Info 'management exposure not checked: hub unreachable' }
    else { Ae-Fail "management API answers through $CpaUrl (HTTP $cpaM): serve must mount /v1 only"; Ae-Hint "docs/cpa.md 'Tailscale serve'" }
}

# Optional private inventory: literal paths relative to home, one per line; never opened.
$cpaInventory = Join-Path $Repo '.tools/legacy-cpa-paths.list'
if (Test-Path -LiteralPath $cpaInventory -PathType Leaf) {
    $cpaOld = 0
    foreach ($p in (Get-Content -LiteralPath $cpaInventory)) {
        if ($p -and -not $p.StartsWith('#') -and (Test-Path -LiteralPath (Join-Path $HOME $p) -PathType Leaf)) { $cpaOld++ }
    }
    if ($cpaOld -eq 0) { Ae-Ok 'no legacy credential files from the private inventory' }
    else { Ae-Warn ("{0} legacy credential files remain; consult the owner's private inventory" -f $cpaOld) }
} else { Ae-Info 'legacy credential scan skipped: no local private inventory' }

if ($Role -eq 'hub') {
    $cpaRel = Ae-TomlGet $Versions 'hub.easycliproxyapi' 'install_dir'
    $cpaDir = $env:CPA_APP_DIR
    if (-not $cpaDir) { $cpaDir = Join-Path $HOME ($cpaRel -replace '/', '\') }
    $cpaGui = Join-Path $cpaDir 'config.toml'
    $cpaCore = Join-Path $cpaDir 'cpa-core\config.yaml'
    if ((Test-Path -LiteralPath $cpaGui) -and (Test-Path -LiteralPath $cpaCore)) {
        Ae-Ok 'CPA install found (versions.toml [hub.easycliproxyapi] install_dir)'
        if ([IO.Path]::GetFullPath($cpaDir).StartsWith((Join-Path $HOME 'Downloads') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Ae-Warn 'CPA still runs from ~/Downloads'; Ae-Hint "docs/cpa.md 'Stable install path' (planned move, not done by apply)" }
        # Matched in memory; the files hold keys, so nothing from them is printed.
        $y = [System.IO.File]::ReadAllText($cpaCore)
        $t = [System.IO.File]::ReadAllText($cpaGui)
        if ($y -match '(?m)^\s+allow-remote:\s*false\s*$') { Ae-Ok 'core management allow-remote is false' } else { Ae-Fail 'core management allow-remote is not false'; Ae-Hint 'set it to false in the GUI, then restart it' }
        if ($y -match '(?m)^\s+host:\s*[''"]?127\.0\.0\.1[''"]?\s*$') { Ae-Ok 'core listens on 127.0.0.1 only' } else { Ae-Fail 'core server.host is not 127.0.0.1' }
        if (($t -match '(?m)^host\s*=\s*"127\.0\.0\.1"') -and ($t -match '(?m)^allow-lan\s*=\s*false')) { Ae-Ok 'GUI host is 127.0.0.1 and allow-lan is false' } else { Ae-Fail 'GUI host/allow-lan would expose CPA beyond loopback' }
        $y = $null; $t = $null
    } else {
        Ae-Fail 'CPA install not found at versions.toml [hub.easycliproxyapi] install_dir'
        Ae-Hint 'persist CPA_APP_DIR for this user (docs/cpa.md Stable install path); then rerun'
    }

    if (Get-Command 'tailscale' -ErrorAction SilentlyContinue) {
        $sj = (& tailscale serve status --json 2>$null) -join "`n"
        $mounts = @()
        $proxies = @()
        $funnel = $false
        if ($sj) {
            $s = $sj | ConvertFrom-Json
            if ($s.AllowFunnel) { foreach ($pp in $s.AllowFunnel.PSObject.Properties) { if ($pp.Value) { $funnel = $true } } }
            if ($s.Web) {
                foreach ($w in $s.Web.PSObject.Properties) {
                    foreach ($h in $w.Value.Handlers.PSObject.Properties) { $mounts += $h.Name; $proxies += [string]$h.Value.Proxy }
                }
            }
        }
        if (($mounts.Count -eq 1) -and ($mounts[0] -eq '/v1') -and ($proxies[0] -eq 'http://127.0.0.1:8317/v1')) {
            Ae-Ok 'tailscale serve mounts /v1 -> 127.0.0.1:8317/v1 only'
        } elseif ($mounts.Count -eq 0) {
            Ae-Fail 'tailscale serve has no /v1 mount: clients cannot reach the hub'; Ae-Hint "docs/cpa.md 'Tailscale serve'"
        } else {
            Ae-Fail ("tailscale serve mounts {0} path(s), expected /v1 only" -f $mounts.Count); Ae-Hint "docs/cpa.md 'Tailscale serve'"
        }
        if ($funnel) { Ae-Fail 'Tailscale Funnel is on: the hub would be public'; Ae-Hint 'tailscale funnel reset' } else { Ae-Ok 'Funnel is off' }
        $st = (& tailscale status --json --peers=false 2>$null) -join "`n"
        if ($st) {
            $tags = @(($st | ConvertFrom-Json).Self.Tags)
            if ($tags -contains 'tag:cpa-hub') { Ae-Ok 'this node carries tag:cpa-hub' }
            else { Ae-Warn 'this node is not tagged tag:cpa-hub: the tailnet grant is not in force yet'; Ae-Hint 'tailscale/policy-snippet.hujson' }
        }
        $sj = $null; $st = $null; $s = $null
    }

    if (-not (Test-Path -LiteralPath (Join-Path $HOME '.cpa-tools\soonest_reset.py') -PathType Leaf)) {
        Ae-Warn "private rebalancer missing; restore it from the owner's private backup"
    }

    $cpaPythonReady = $false
    if (Ae-Have 'py') {
        & py -3 -c 'import sys, tomllib; sys.exit(0 if sys.version_info >= (3, 11) else 1)' *> $null
        $cpaPythonReady = ($LASTEXITCODE -eq 0)
    }
    if ($cpaPythonReady) { Ae-Ok 'Python 3.11+ for ~/.cpa-tools' } else { Ae-Warn 'Python 3.11+ (py -3) missing: apply installs Python for ~/.cpa-tools' }
}
