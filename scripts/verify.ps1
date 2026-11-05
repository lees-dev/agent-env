# Post-apply verification for Windows native. WSL, Linux, macOS: scripts/verify.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
#
# Base checks (this file): chezmoi is the pinned version and initialised, the target state
# matches the source state (`chezmoi verify`), each selected harness runs at its pin, and
# a backup exists. Each area adds its own checks as scripts/verify.d/<NN>-<area>.ps1,
# dot-sourced in name order with the same helpers and counters (see docs/layout.md).
#
# Read-only. Never prints a secret, an account email or file contents.
# Exit 0 when nothing FAILed, 1 otherwise. Windows PowerShell 5.1 compatible, ASCII only.
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib/common.ps1')
Ae-RefreshPath
$Versions = Join-Path $Repo 'versions.toml'
. (Join-Path $PSScriptRoot 'lib/load-cpa-dir.ps1')
Ae-LoadCpaDir

Write-Host 'agent-env verify'

Ae-Section 'chezmoi'
if (-not (Ae-Have 'chezmoi')) { Ae-Fail 'chezmoi not installed'; [void](Ae-Summary 'verify'); exit 1 }
$pin = Ae-TomlGet $Versions 'tools.chezmoi' 'version'
$have = Ae-Semver (& chezmoi --version 2>$null)
if ($have -eq $pin) { Ae-Ok "chezmoi $have" } else { Ae-Fail "chezmoi $have, pin $pin" }

$Role = Ae-ChezmoiData 'role'
$Machine = Ae-ChezmoiData 'machine'
$Harnesses = @()
$hs = & chezmoi execute-template '{{ range .harnesses }}{{ . }} {{ end }}' 2>$null
if ($LASTEXITCODE -eq 0 -and $hs) { $Harnesses = @(([string]$hs).Split(' ') | Where-Object { $_ }) }
if (-not $Role) { Ae-Fail 'chezmoi is not initialised for this repo'; Ae-Hint 'AGENTS.md step 3'; [void](Ae-Summary 'verify'); exit 1 }
Ae-Ok ("initialised: role={0} machine={1} harnesses={2}" -f $Role, $Machine, ($Harnesses -join ' '))
$src = [string](& chezmoi source-path 2>$null)
$srcFull = ''
if ($src) { $srcFull = [System.IO.Path]::GetFullPath(($src -replace '/', '\')).TrimEnd('\') }
if ($srcFull -ieq $Repo -or $srcFull -ieq (Join-Path $Repo 'home')) { Ae-Ok 'source is this checkout' }
else { Ae-Fail 'chezmoi source is not this checkout'; Ae-Hint "chezmoi init --source `"$Repo`"" }
. (Join-Path $PSScriptRoot 'lib/load-token.ps1')
Ae-LoadToken (Ae-ChezmoiData 'opMode')
# Scripts are excluded: run_onchange_ scripts are verified by their own areas' checks.
& chezmoi verify --exclude=scripts *> $null
if ($LASTEXITCODE -eq 0) { Ae-Ok 'target state matches source state' }
else {
    $n = @(& chezmoi status --exclude=scripts 2>$null).Count
    Ae-Fail "target state differs from source state ($n entries)"
    Ae-Hint 'chezmoi status --exclude=scripts   (then: scripts/backup.ps1; chezmoi apply)'
}

Ae-Section 'Harnesses'
# See PATH the way a new terminal does (Machine + User from the registry), so a shell started
# before the apply does not report a freshly installed harness as missing.
$vParts = @()
foreach ($vScope in 'Machine', 'User') { $vVal = [Environment]::GetEnvironmentVariable('Path', $vScope); if ($vVal) { $vParts += $vVal.Split(';') } }
$env:Path = (($vParts + $env:Path.Split(';')) | Where-Object { $_ } | Select-Object -Unique) -join ';'
foreach ($h in $Harnesses) {
    $pin = Ae-Pin $Versions 'harness' $h $Machine
    $srcv = Ae-TomlGet $Versions "harness.$h" 'source'
    if (-not (Ae-Have $h)) { Ae-Fail "$h not on PATH (pin $pin)"; continue }
    $have = Ae-Semver ((& $h --version 2>$null) | Select-Object -First 1)
    if ($have -eq $pin) { Ae-Ok "$h $have" }
    elseif ($srcv -eq 'observed') { Ae-Warn "$h $have, observed pin $pin (no registry to pin from)" }
    else { Ae-Fail "$h $have, pin $pin" }
}

Ae-Section 'Backups'
$root = $env:AGENT_ENV_BACKUP_ROOT
if (-not $root) { $root = Join-Path $HOME '.agent-env-backups' }
$last = $null
if (Test-Path -LiteralPath $root) { $last = Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name | Select-Object -Last 1 }
if ($last) { Ae-Ok ("latest backup {0}" -f $last.Name) }
else { Ae-Warn "no backup under $root"; Ae-Hint 'scripts/backup.ps1 runs before every apply' }

foreach ($f in (Ae-Dropins (Join-Path $PSScriptRoot 'verify.d'))) {
    Ae-Section ("verify: " + $f.BaseName)
    . $f.FullName
}

if (Ae-Summary 'verify') { exit 0 } else { exit 1 }
