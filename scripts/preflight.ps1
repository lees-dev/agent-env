# Read-only preflight for Windows native. WSL, Linux and macOS: scripts/preflight.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preflight.ps1 `
#          [-Role hub|client|server] [-Machine REMARK] [-Vault NAME] [-CpaUrl URL]
# Values fall back to $env:AGENT_ENV_ROLE / _MACHINE / _OP_VAULT / _CPA_URL, then to this
# machine's chezmoi data, then to the defaults in home/.chezmoi.toml.tmpl.
#
# It changes nothing: no installs, no writes, no sign-ins. It never prints a secret or an
# account email. Exit 0 when nothing FAILed, 1 otherwise.
# Windows PowerShell 5.1 compatible, ASCII only.
param(
    [string]$Role = '',
    [string]$Machine = '',
    [string]$Vault = '',
    [string]$CpaUrl = ''
)
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib/common.ps1')
Ae-RefreshPath
$Versions = Join-Path $Repo 'versions.toml'
. (Join-Path $PSScriptRoot 'lib/load-cpa-dir.ps1')
Ae-LoadCpaDir

if (-not $Role) { $Role = $env:AGENT_ENV_ROLE }
if (-not $Machine) { $Machine = $env:AGENT_ENV_MACHINE }
if (-not $Vault) { $Vault = $env:AGENT_ENV_OP_VAULT }
if (-not $CpaUrl) { $CpaUrl = $env:AGENT_ENV_CPA_URL }
if (-not $Role) { $Role = Ae-ChezmoiData 'role' }
if (-not $Machine) { $Machine = Ae-ChezmoiData 'machine' }
if (-not $Vault) { $Vault = Ae-ChezmoiData 'opVault' }
if (-not $CpaUrl) { $CpaUrl = Ae-ChezmoiData 'cpaUrl' }
if (-not $Role) { $Role = 'client' }
if (-not $Machine) { $Machine = $env:COMPUTERNAME.ToLowerInvariant() }
$OpMode = $env:AGENT_ENV_OP_MODE
if (-not $OpMode) { $OpMode = Ae-ChezmoiData 'opMode' }
if (-not $OpMode) { $OpMode = 'service' }
if (-not $Vault) { if ($OpMode -eq 'service' -and $Role -ne 'hub') { $Vault = "agent-env-$Machine" } else { $Vault = 'agent-env' } }
if (-not $CpaUrl) { $CpaUrl = 'https://beast-1.tail7f661e.ts.net' }
$CpaUrl = $CpaUrl.TrimEnd('/')
if ($CpaUrl.EndsWith('/v1')) { $CpaUrl = $CpaUrl.Substring(0, $CpaUrl.Length - 3) }

Write-Host 'agent-env preflight (read-only)'
Write-Host "  role=$Role machine=$Machine os=windows vault=$Vault hub=$CpaUrl"

# ---------------------------------------------------------------------------------------
Ae-Section 'Platform'
Ae-Ok ("Windows {0}, PowerShell {1}" -f [Environment]::OSVersion.Version, $PSVersionTable.PSVersion)
if (@('hub', 'client', 'server') -contains $Role) { Ae-Ok "role $Role" } else { Ae-Fail "role '$Role' must be hub, client or server" }
if ($Machine -cmatch '^[a-z0-9][a-z0-9-]{0,62}$') { Ae-Ok "machine remark $Machine" } else { Ae-Fail "machine remark '$Machine' must match ^[a-z0-9][a-z0-9-]{0,62}$" }
if ($Role -eq 'server') { Ae-Warn 'server role on Windows: the server role is meant for headless Linux hosts' }

# Claude desktop app (MSIX): writes under %APPDATA%/%LOCALAPPDATA% are redirected into the
# package. Walk the parent processes looking for the package path.
$inMsix = $false
try {
    $procId = $PID
    for ($i = 0; $i -lt 12 -and $procId; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
        if (-not $p) { break }
        if ($p.ExecutablePath -and $p.ExecutablePath -match '\\WindowsApps\\Claude_') { $inMsix = $true; break }
        $procId = $p.ParentProcessId
    }
} catch { }
if ($inMsix) {
    Ae-Warn 'running under the Claude desktop app (MSIX): apply would write into the package, not your profile'
    Ae-Hint 'run the apply step from a normal terminal (Windows Terminal, PowerShell, Git Bash)'
} else {
    Ae-Ok 'not inside the Claude desktop MSIX package'
}

# ---------------------------------------------------------------------------------------
Ae-Section 'Repository'
if (Ae-Have 'git') {
    $gv = Ae-Semver (& git --version)
    Ae-Ok ("git {0} (pin {1})" -f $gv, (Ae-TomlGet $Versions 'tools.git' 'windows'))
    $bad = 0
    foreach ($l in (& git -C $Repo ls-files --eol 2>$null)) {
        $f = $l -split '\s+'
        if ($f.Count -lt 3) { continue }
        if ($f[0] -match 'i/(crlf|mixed)') { $bad++; continue }
        if ($f[1] -match 'w/(crlf|mixed)' -and $f[2] -notmatch 'eol=crlf') { $bad++ }
    }
    if ($bad -eq 0) { Ae-Ok 'checkout line endings are LF' }
    else {
        Ae-Fail "$bad tracked files have CRLF line endings in this checkout"
        Ae-Hint "git -C `"$Repo`" config core.autocrlf false; git -C `"$Repo`" checkout -- ."
    }
} else {
    Ae-Fail 'git not found'
}
$backupRoot = Join-Path $HOME '.agent-env-backups'
if ($backupRoot.StartsWith($Repo, [StringComparison]::OrdinalIgnoreCase)) { Ae-Fail 'backup root would be inside the repo' }
else { Ae-Ok "backup root $backupRoot is outside the repo" }

# ---------------------------------------------------------------------------------------
Ae-Section 'chezmoi'
$pin = Ae-TomlGet $Versions 'tools.chezmoi' 'version'
if (Ae-Have 'chezmoi') {
    $have = Ae-Semver (& chezmoi --version 2>$null)
    if ($have -eq $pin) { Ae-Ok "chezmoi $have" } else { Ae-Warn "chezmoi $have, pin $pin"; Ae-Hint 'AGENTS.md step 2 installs the pinned version' }
} else {
    Ae-Warn "chezmoi not installed (pin $pin)"; Ae-Hint 'AGENTS.md step 2 installs it'
}

# ---------------------------------------------------------------------------------------
Ae-Section '1Password (op)'
. (Join-Path $PSScriptRoot 'lib/load-token.ps1')
Ae-LoadToken $OpMode
$pin = Ae-TomlGet $Versions 'tools.op' 'version'
$opReady = $false
if (-not (Ae-Have 'op')) {
    Ae-Fail "1Password CLI 'op' not found (pin $pin)"
    Ae-Hint "install: winget install --id AgileBits.1Password.CLI --version $pin --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity  (docs: https://developer.1password.com/docs/cli/get-started/)"
} else {
    Ae-Ok ("op {0} (pin {1})" -f (Ae-Semver ($null | & op --version 2>$null)), $pin)
    if ($OpMode -notin @('service', 'account')) {
        Ae-Fail '1Password mode must be service or account'
    } elseif ($OpMode -eq 'service' -and -not $env:OP_SERVICE_ACCOUNT_TOKEN) {
        Ae-Fail 'service mode needs OP_SERVICE_ACCOUNT_TOKEN; no desktop sign-in attempted'
    } else {
        $null | & op whoami *> $null
        if ($LASTEXITCODE -eq 0) { Ae-Ok "op signed in ($OpMode mode)"; $opReady = $true }
        else { Ae-Fail "op is not signed in ($OpMode mode)" }
    }
    if (-not $opReady) {
        Ae-Hint "default: persist this device's service token for its user (docs/cpa.md '1Password vaults')"
        if ($Role -eq 'hub') {
            Ae-Hint "hub: owner restores its service token; client-key vault agent-env"
        } else {
            Ae-Hint "BEAST can create vault 'agent-env-$Machine' and mint its key; the owner approves"
            Ae-Hint '  creating its read-only service account once on BEAST (the only 1Password prompt)'
        }
        Ae-Hint 'owner: use the no-echo entry and User environment persistence procedure in docs/cpa.md in your own terminal'
        Ae-Hint 'then rerun preflight without restarting the agent; keep the persisted token after verify'
        Ae-Hint 'account mode is opt-in: desktop CLI integration or op signin (may prompt)'
    }
}
if ($opReady) {
    $null | & op vault get $Vault *> $null
    if ($LASTEXITCODE -eq 0) {
        Ae-Ok "vault '$Vault' readable"
        $item = "cpa-client-$Machine"
        # Lists titles only; the JSON stays in memory and no field value is fetched.
        $json = ($null | & op item list --vault $Vault --format json 2>$null) -join "`n"
        if ($json -match ('"title":\s*"' + [regex]::Escape($item) + '"')) { Ae-Ok "item '$item' exists" }
        else {
            Ae-Fail "item '$item' not found in vault '$Vault'"
            Ae-Hint "mint a key for remark '$Machine' on the hub and store it as item '$item' (docs/cpa.md)"
        }
        $json = $null
    } else {
        Ae-Fail "vault '$Vault' not readable by this op session"
        Ae-Hint 'create it or grant this account/service account read access, then rerun'
    }
}
# BEAST's hub admin account may read all agent vaults. Device accounts see their own key,
# plus the shared repo-credentials vault agent-repos (not item-scanned; docs/cpa.md).
# Counts titles only; no field value is fetched and no title is printed.
if ($opReady -and $OpMode -eq 'service') {
    if ($Role -eq 'hub') {
        Ae-Ok 'hub service mode: device scope check does not apply'
    } else {
        if ($Vault -ne "agent-env-$Machine") { Ae-Warn "service mode reads vault '$Vault': use a vault of its own, 'agent-env-$Machine' (docs/cpa.md '1Password vaults')" }
        $opNv = 0; $opExtra = 0; $opRepos = $false
        $opVaults = @()
        # Windows PowerShell 5.1 emits a JSON array as one object: assign it, then enumerate.
        try {
            $j = (($null | & op vault list --format json 2>$null) -join "`n") | ConvertFrom-Json -ErrorAction Stop
            if ($LASTEXITCODE -ne 0) { throw 'op failed' }
            $opVaults = @($j)
        } catch { Ae-Fail 'cannot list service-account vaults to check scope' }
        foreach ($v in $opVaults) {
            if (-not $v.id) { continue }
            if ([string]$v.name -eq 'agent-repos') { $opRepos = $true; continue }
            $opNv++
            $its = @()
            try {
                $j = (($null | & op item list --vault $v.id --format json 2>$null) -join "`n") | ConvertFrom-Json -ErrorAction Stop
                if ($LASTEXITCODE -ne 0) { throw 'op failed' }
                $its = @($j)
            } catch { Ae-Fail 'cannot list service-account items to check scope' }
            foreach ($it in $its) {
                $t = [string]$it.title
                if ($t -eq "cpa-client-$Machine") { continue }
                $opExtra++
            }
            $its = $null
        }
        if ($opNv -eq 1 -and $opExtra -eq 0) { Ae-Ok 'device service account sees one key vault and only its own key' }
        else {
            if ($opNv -ne 1) { Ae-Warn "device service account sees $opNv vault(s), expected one" }
            if ($opExtra -gt 0) { Ae-Warn "device service account can read $opExtra unexpected item(s)" }
            Ae-Hint "scope this machine's service account read-only to vault 'agent-env-$Machine', plus read+write on 'agent-repos' (docs/cpa.md)"
        }
        if ($opRepos) { Ae-Ok "device service account reaches vault 'agent-repos' (repo dev credentials)" }
        else { Ae-Warn "device service account cannot reach vault 'agent-repos': repo dev credentials will not inject (docs/cpa.md '1Password vaults')" }
        $opVaults = $null; $j = $null
    }
}

# ---------------------------------------------------------------------------------------
Ae-Section 'Tailscale and hub'
$ts = Get-Command 'tailscale' -ErrorAction SilentlyContinue
if ($ts) {
    Ae-Ok ("tailscale {0} (pin {1})" -f (Ae-Semver ((& tailscale version 2>$null) | Select-Object -First 1)), (Ae-TomlGet $Versions 'tools.tailscale' 'version'))
    $st = (& tailscale status --json --peers=false 2>$null) -join "`n"
    if ($st -match '"BackendState":\s*"Running"') { Ae-Ok 'tailscale is up' }
    else { Ae-Fail 'tailscale is not running or not logged in'; Ae-Hint 'tailscale up   (interactive login)' }
    $st = $null
} else {
    Ae-Fail 'tailscale not found'; Ae-Hint 'install: winget install --id tailscale.tailscale, then tailscale up'
}
function Get-HttpCode {
    param([string]$url, [int]$timeout)
    $c = & curl.exe -sS -o NUL -w '%{http_code}' --max-time $timeout $url 2>$null
    if (-not $c) { return '000' }
    return [string]$c
}
if (Get-Command 'curl.exe' -ErrorAction SilentlyContinue) {
    # No key is sent: 401/403 proves the hub answered, 200 means it is open (report it).
    $code = Get-HttpCode "$CpaUrl/v1/models" 10
    switch -regex ($code) {
        '^(401|403)$' { Ae-Ok "hub reachable at $CpaUrl (HTTP $code without a key)" }
        '^200$' { Ae-Warn 'hub answered 200 without a key: client-key auth looks off (docs/cpa.md)' }
        '^000$' { Ae-Fail "hub $CpaUrl unreachable"; Ae-Hint "check 'tailscale status', the tailnet grant for this device, and that Beast is on" }
        default { Ae-Warn "hub answered HTTP $code" }
    }
    if ($Role -eq 'hub') {
        $code = Get-HttpCode 'http://127.0.0.1:8317/v1/models' 5
        if ($code -eq '000') { Ae-Fail 'CLIProxyAPI not listening on 127.0.0.1:8317' } else { Ae-Ok "CLIProxyAPI on 127.0.0.1:8317 (HTTP $code)" }
    }
} else {
    Ae-Fail 'curl.exe not found'
}

# ---------------------------------------------------------------------------------------
Ae-Section 'Harnesses'
$fallback = @{
    'grok' = (Join-Path $HOME '.grok\bin\grok.exe')
    'muse' = (Join-Path $env:LOCALAPPDATA 'Programs\muse\muse.cmd')
}
foreach ($h in @('claude', 'codex', 'grok', 'muse')) {
    $pin = Ae-Pin $Versions 'harness' $h $Machine
    $cmd = Get-Command $h -ErrorAction SilentlyContinue | Select-Object -First 1
    $bin = $null
    if ($cmd) { $bin = $cmd.Source } elseif ($fallback.ContainsKey($h) -and (Test-Path -LiteralPath $fallback[$h])) { $bin = $fallback[$h] }
    if (-not $bin) { Ae-Warn "$h not installed (pin $pin)"; continue }
    $have = Ae-Semver ((& $bin --version 2>$null) | Select-Object -First 1)
    if (-not $cmd) { Ae-Warn "$h $have found at $bin but not on PATH" }
    elseif ($have -eq $pin) { Ae-Ok "$h $have" }
    else { Ae-Warn "$h $have, pin $pin" }
}

Ae-Section 'Other tools'
foreach ($t in @('node', 'npm', 'gh', 'uv')) {
    $pin = Ae-Pin $Versions 'tools' $t $Machine
    $suffix = ''
    if ($pin) { $suffix = " (pin $pin)" }
    if (Ae-Have $t) { Ae-Ok ("{0} {1}{2}" -f $t, (Ae-Semver ((& $t --version 2>$null) | Select-Object -First 1)), $suffix) }
    else { Ae-Warn "$t not installed$suffix" }
}

# ---------------------------------------------------------------------------------------
foreach ($f in (Ae-Dropins (Join-Path $PSScriptRoot 'preflight.d'))) {
    Ae-Section ("preflight: " + $f.BaseName)
    . $f.FullName
}

if (Ae-Summary 'preflight') { exit 0 } else { exit 1 }
