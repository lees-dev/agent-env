# Back up every file `chezmoi apply` may touch, before it touches it. Windows native.
# WSL, Linux, macOS: scripts/backup.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 [-DryRun]
#
# What it copies, into ~/.agent-env-backups/<UTC timestamp>/ (never inside this repo):
#   1. every file and symlink chezmoi manages on this machine (`chezmoi managed`)
#   2. every path listed in scripts/backup.d/*.list: files the run_ scripts change outside
#      chezmoi's view (for example ~/.claude.json, which `claude mcp add` rewrites)
# Junctions and symlinks are recorded (with their target), not followed. Directories are
# copied with robocopy /XJ so junctions inside them are not followed either. A manifest.tsv
# lists each entry with its kind, size and sha256. The backup holds live credentials.
#
# Restore one file: Copy-Item ~/.agent-env-backups/<ts>/<path> ~/<path>
# Output is counts only; never file contents. Windows PowerShell 5.1 compatible, ASCII only.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib/common.ps1')
. (Join-Path $PSScriptRoot 'lib/load-token.ps1')
. (Join-Path $PSScriptRoot 'lib/load-cpa-dir.ps1')
Ae-LoadCpaDir
Ae-LoadToken (Ae-ChezmoiData 'opMode')

$Root = $env:AGENT_ENV_BACKUP_ROOT
if (-not $Root) { $Root = Join-Path $HOME '.agent-env-backups' }
$Root = [System.IO.Path]::GetFullPath($Root)
if (($Root + '\').StartsWith($Repo + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: backup root $Root is inside the repo" }
$Dest = Join-Path $Root ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))

if (-not (Ae-Have 'chezmoi')) { throw 'chezmoi not installed: run AGENTS.md step 2 first' }
& chezmoi execute-template '{{ .role }}' *> $null
if ($LASTEXITCODE -ne 0) { throw 'chezmoi not initialised: run AGENTS.md step 3 first' }

$homeFull = [System.IO.Path]::GetFullPath($HOME).TrimEnd('\')
$paths = New-Object System.Collections.Generic.List[string]
foreach ($p in (& chezmoi managed --include=files,symlinks --path-style=absolute)) { if ($p) { $paths.Add($p) } }
$lists = @()
$bd = Join-Path $PSScriptRoot 'backup.d'
if (Test-Path -LiteralPath $bd) { $lists = @(Get-ChildItem -LiteralPath $bd -Filter '*.list' -File | Sort-Object Name) }
foreach ($l in $lists) {
    foreach ($line in [System.IO.File]::ReadAllLines($l.FullName)) {
        $t = ($line -replace '#.*$', '').Trim()
        if (-not $t) { continue }
        if ($t.StartsWith('~/')) { $t = $t.Substring(2) }
        if (-not [System.IO.Path]::IsPathRooted($t)) { $t = Join-Path $homeFull $t }
        $paths.Add($t)
    }
}

$copied = 0; $links = 0; $missing = 0; $outside = 0
$manifest = Join-Path $Dest 'manifest.tsv'
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    [System.IO.File]::WriteAllText($manifest, "kind`tpath`tsize`tsha256`n")
}

foreach ($p in ($paths | ForEach-Object { [System.IO.Path]::GetFullPath(($_ -replace '/', '\')) } | Sort-Object -Unique)) {
    if (-not $p.StartsWith($homeFull + '\', [StringComparison]::OrdinalIgnoreCase)) { $outside++; Write-Host "  skip (outside home): $p"; continue }
    $rel = $p.Substring($homeFull.Length + 1)
    $relFwd = $rel -replace '\\', '/'
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if (-not $item) { $missing++; continue }
    if ($item.LinkType) {
        $links++
        if (-not $DryRun) { [System.IO.File]::AppendAllText($manifest, ("{0}`t{1}`t-`t{2}`n" -f $item.LinkType.ToLowerInvariant(), $relFwd, (@($item.Target) -join ';'))) }
        continue
    }
    $copied++
    if ($DryRun) { continue }
    $target = Join-Path $Dest $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    if ($item.PSIsContainer) {
        & robocopy.exe $p $target /E /XJ /COPY:DAT /DCOPY:T /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) for $relFwd" }
        [System.IO.File]::AppendAllText($manifest, "dir`t$relFwd`t-`t-`n")
    } else {
        Copy-Item -LiteralPath $p -Destination $target -Force
        $hash = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
        [System.IO.File]::AppendAllText($manifest, ("file`t{0}`t{1}`t{2}`n" -f $relFwd, $item.Length, $hash))
    }
}
$global:LASTEXITCODE = 0

if ($DryRun) {
    Write-Host "backup dry run: $copied to copy, $links links to record, $missing not present yet, $outside outside home"
} else {
    Write-Host "backup: $copied copied, $links links recorded, $missing not present yet, $outside outside home"
    Write-Host "  -> $Dest"
}
