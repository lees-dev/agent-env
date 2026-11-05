# Secret-free tools stage. Run in a child Windows PowerShell, never dot-source.
# Usage: $env:AGENT_ENV_SYSTEM_PACKAGES='1'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-tools.ps1
param([ValidateSet('client','hub','server')][string]$Role = 'client', [string]$Machine = '')
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
# This library is sourced only inside this child process.
. (Join-Path $Repo 'home\.chezmoitemplates\packages\lib.ps1')
Pk-AssertNotMsix
Pk-RefreshPath
$env:AGENT_ENV_ROLE = $Role
$env:AGENT_ENV_MACHINE = $Machine
$env:AGENT_ENV_TOOLS_REPO = $Repo.Replace('\','/')
if ($Role -eq 'server') { $env:AGENT_ENV_SYSTEM_PACKAGES = '0' }
$cz = $env:AGENT_ENV_CHEZMOI
if (-not $cz) { $cz = 'chezmoi' }
if (-not (Get-Command $cz -ErrorAction SilentlyContinue)) {
    if (Pk-Dry) { throw 'dry-run needs chezmoi (or AGENT_ENV_CHEZMOI)' }
    $versions = [IO.File]::ReadAllText((Join-Path $Repo 'versions.toml'))
    $pin = [regex]::Match($versions, '(?ms)^\[tools.chezmoi\]\s*version = "([^"]+)"').Groups[1].Value
    if (-not $pin) { throw 'chezmoi pin missing' }
    # The pinned manifest uses portable ZIP installers; keep bootstrap user-level on every role.
    & winget install --id twpayne.chezmoi --version $pin --scope user --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'chezmoi bootstrap failed' }
    Pk-RefreshPath
    $cz = 'chezmoi'
}
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $Repo '.tools'))
$scratch = Join-Path $toolsRoot ('tools-stage-' + [Guid]::NewGuid().ToString('N'))
# Validate the absolute cleanup target before creating anything.
$scratch = [IO.Path]::GetFullPath($scratch)
if (-not $scratch.StartsWith($toolsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe tools scratch path' }
$source = Join-Path $scratch 'source'
New-Item -ItemType Directory -Path $source -Force | Out-Null
try {
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $Repo 'packages\tools-stage.txt'))) {
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.Contains('..') -or [IO.Path]::IsPathRooted($line)) { throw 'invalid tools allowlist path' }
        $target = Join-Path $source $line
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path (Join-Path $Repo 'home') $line) -Destination $target
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools-config.toml.tmpl') -Destination (Join-Path $source '.chezmoi.toml.tmpl')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools-ignore.tmpl') -Destination (Join-Path $source '.chezmoiignore')
    $dest = $env:USERPROFILE
    if (Pk-Dry) { $dest = Join-Path $scratch 'destination'; New-Item -ItemType Directory -Path $dest | Out-Null }
    $argsCz = @('--source', $source, '--config', (Join-Path $scratch 'config.toml'), '--persistent-state', (Join-Path $scratch 'state.boltdb'), '--cache', (Join-Path $scratch 'cache'), '--destination', $dest, '--no-tty')
    & $cz init @argsCz
    if ($LASTEXITCODE -ne 0) { throw 'tools init failed' }
    if (Pk-Dry) {
        foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $source '.chezmoiscripts') -Filter '*.ps1.tmpl' | Sort-Object Name)) {
            $rendered = & $cz execute-template @argsCz --file $file.FullName
            if ($LASTEXITCODE -ne 0) { throw 'tools render failed' }
            if (-not $rendered) { continue }
            $run = Join-Path $scratch 'run.ps1'
            [IO.File]::WriteAllLines($run, [string[]]$rendered, (New-Object Text.UTF8Encoding($false)))
            & powershell -NoProfile -ExecutionPolicy Bypass -File $run
            if ($LASTEXITCODE -ne 0) { throw 'tools dry-run failed' }
        }
    } else {
        & $cz apply @argsCz
        if ($LASTEXITCODE -ne 0) { throw 'tools apply failed' }
    }
    Write-Host 'tools: complete (all four harnesses; desktop apps excluded on server)'
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
