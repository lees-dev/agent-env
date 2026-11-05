# packages preflight (Windows). Dot-sourced by scripts/preflight.ps1: read-only, never exits.
# Uses $Repo $Versions $Role $Machine and the Ae-* helpers. Windows PowerShell 5.1, ASCII only.

# winget (App Installer) drives every tool install on Windows.
. (Join-Path $Repo 'home\.chezmoitemplates\packages\lib.ps1')
$pkWinget = Get-Command winget -ErrorAction SilentlyContinue
$pkPin = Ae-TomlGet $Versions 'tools.winget' 'version'
if ($pkWinget) {
    $pkHave = Ae-Semver (& winget --version 2>$null)
    $pkOlder = $false
    $pkA = $pkHave.Split('.'); $pkB = $pkPin.Split('.')
    for ($i = 0; $i -lt 3; $i++) {
        if ([int]$pkA[$i] -lt [int]$pkB[$i]) { $pkOlder = $true; break }
        if ([int]$pkA[$i] -gt [int]$pkB[$i]) { break }
    }
    if ($pkOlder) { Ae-Warn "winget $pkHave is older than $pkPin"; Ae-Hint 'update App Installer from the Microsoft Store' }
    else { Ae-Ok "winget $pkHave" }
} else {
    Ae-Fail 'winget not found'; Ae-Hint 'install App Installer from the Microsoft Store, then rerun preflight'
}

# Per-machine packages need UAC, so they run only with the owner's opt-in for that apply.
$pkMachine = @()
$pkMachineNames = @()
foreach ($l in [IO.File]::ReadAllLines((Join-Path $Repo 'packages\winget.txt'))) {
    $t = ($l -replace '#.*$', '').Trim()
    if (-not $t) { continue }
    $c = $t.Split('|') | ForEach-Object { $_.Trim() }
    if ($c.Count -ge 6 -and $Role -eq 'server') { continue }
    if ($c[3] -eq 'machine') {
        $pkMachineNames += $c[1]
        $probe = $c[2].Split(' ')
        if ($probe[0].StartsWith('@')) {
            if (-not (Pk-Version $probe[0] @())) { $pkMachine += $c[1] }
        } elseif (-not (Get-Command $probe[0] -ErrorAction SilentlyContinue)) { $pkMachine += $c[1] }
    }
}
if ($pkMachine.Count -eq 0) { Ae-Ok ("per-machine packages ({0}) present" -f ($pkMachineNames -join ', ')) }
elseif ($env:AGENT_ENV_SYSTEM_PACKAGES -eq '1') { Ae-Warn ("missing per-machine packages: {0}; the apply installs them with UAC prompts" -f ($pkMachine -join ', ')) }
else {
    Ae-Warn ("missing per-machine packages: {0}" -f ($pkMachine -join ', '))
    Ae-Hint "they need the owner's OK (UAC): `$env:AGENT_ENV_SYSTEM_PACKAGES = '1' before chezmoi apply"
}

# Git Bash: Claude Code's Bash tool and every .sh in this repo use it.
$pkBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (Test-Path -LiteralPath $pkBash) { Ae-Ok 'Git Bash present' }
else { Ae-Warn 'Git Bash not found (Git for Windows installs it; winget id Git.Git)' }

# The user PATH entries the apply would add (report only).
$pkRaw = [string](Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$pkHaveP = @{}
foreach ($e in $pkRaw.Split(';')) { if ($e) { $pkHaveP[[Environment]::ExpandEnvironmentVariables($e).TrimEnd('\').ToLowerInvariant()] = $true } }
$pkMissing = @()
foreach ($w in @("$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.grok\bin", "$env:LOCALAPPDATA\Programs\muse", "$env:APPDATA\npm")) {
    if (-not $pkHaveP.ContainsKey($w.TrimEnd('\').ToLowerInvariant())) { $pkMissing += $w.Replace($env:USERPROFILE, '~') }
}
if ($pkMissing.Count -eq 0) { Ae-Ok 'user PATH has the agent-env entries' }
else { Ae-Warn ("user PATH lacks {0}: the apply adds them" -f ($pkMissing -join ', ')) }

# The vendor download hosts answer (status codes only).
$pkBad = @()
foreach ($u in @('https://claude.ai/install.ps1', 'https://x.ai/cli/install.ps1', 'https://dev.meta.ai/install.ps1', 'https://registry.npmjs.org/@openai%2Fcodex')) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $r = Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        if ($r.StatusCode -ge 400) { $pkBad += $u }
    } catch { $pkBad += $u }
}
if ($pkBad.Count -eq 0) { Ae-Ok 'vendor download hosts reachable' }
else { Ae-Warn ("unreachable: {0}" -f ($pkBad -join ', ')) }

if (Test-Path -LiteralPath (Join-Path $HOME '.config\agent-env\versions.local.toml')) {
    Ae-Info 'machine-local overrides in ~/.config/agent-env/versions.local.toml are in effect'
}
Remove-Variable pkWinget, pkPin, pkHave, pkOlder, pkA, pkB, pkMachine, pkMachineNames, pkBash, pkRaw, pkHaveP, pkMissing, pkBad -ErrorAction SilentlyContinue

# Tools-stage additions: warn before apply, never launch a desktop app to probe it.
foreach ($tool in @('pnpm','bun','rg','mvn.cmd','javac','higgsfield.cmd','vercel.cmd')) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) { Ae-Ok "$tool present" }
    else { Ae-Warn "$tool missing: run scripts/install-tools.ps1 before provisioning" }
}
if ($Role -ne 'server') {
    foreach ($app in @('t3code','toolbox','docker-desktop')) {
        $have = Pk-Version ('@' + $app) @()
        if ($have) { Ae-Ok "$app $have" }
        elseif ($app -eq 't3code') { Ae-Warn "$app missing: the tools stage installs it" }
        else { Ae-Warn "$app missing: the tools stage needs AGENT_ENV_SYSTEM_PACKAGES=1 to install it" }
    }
}
