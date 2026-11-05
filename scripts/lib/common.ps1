# Shared helpers for scripts/preflight.ps1, verify.ps1, backup.ps1 and their .d/ drop-ins.
# Windows PowerShell 5.1 compatible and ASCII only (no ternary, no ??, no && in scripts).
# Dot-source it; do not run it.
#
# Output rules: print check names, statuses and counts. Never print a secret, an account
# email, a file's contents or a log line. Send any output that might hold one to $null.

$script:AeOk = 0
$script:AeWarn = 0
$script:AeFail = 0

function Ae-Ok   { param([string]$m) $script:AeOk++;   Write-Host "  OK    $m" }
function Ae-Warn { param([string]$m) $script:AeWarn++; Write-Host "  WARN  $m" }
function Ae-Fail { param([string]$m) $script:AeFail++; Write-Host "  FAIL  $m" }
function Ae-Info { param([string]$m) Write-Host "  INFO  $m" }
function Ae-Hint { param([string]$m) Write-Host "        -> $m" }
function Ae-Section { param([string]$m) Write-Host ""; Write-Host "== $m" }

function Ae-Have { param([string]$name) return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Print the counts; return $true when nothing failed.
function Ae-Summary {
    param([string]$name)
    Write-Host ""
    Write-Host ("{0}: {1} ok, {2} warn, {3} fail" -f $name, $script:AeOk, $script:AeWarn, $script:AeFail)
    return ($script:AeFail -eq 0)
}

# Read `key = "value"` from [section] of versions.toml (flat format only; see the file header).
function Ae-TomlGet {
    param([string]$file, [string]$section, [string]$key)
    $cur = ''
    foreach ($line in [System.IO.File]::ReadAllLines($file)) {
        $t = $line.Trim()
        if ($t.StartsWith('[')) { $cur = ($t -replace '\s', ''); continue }
        if ($cur -eq "[$section]") {
            $m = [regex]::Match($t, '^' + [regex]::Escape($key) + '\s*=\s*"([^"]*)"')
            if ($m.Success) { return $m.Groups[1].Value }
        }
    }
    return ''
}

# Pinned version of <area>.<name>, or the [overrides.<machine>] value when present.
function Ae-Pin {
    param([string]$file, [string]$area, [string]$name, [string]$machine)
    # ~/.config/agent-env/versions.local.toml [overrides] wins, as in packages/pins.json.
    $lf = Join-Path $HOME '.config\agent-env\versions.local.toml'
    if (Test-Path -LiteralPath $lf) {
        $l = Ae-TomlGet $lf 'overrides' $name
        if ($l) { return $l }
    }
    if ($machine) {
        $o = Ae-TomlGet $file "overrides.$machine" $name
        if ($o) { return $o }
    }
    return (Ae-TomlGet $file "$area.$name" 'version')
}

function Ae-Semver {
    param([string]$text)
    $m = [regex]::Match([string]$text, '(\d+\.\d+\.\d+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# A chezmoi data value once `chezmoi init` has run, else ''. Keys are plain identifiers.
# (No double quotes in the template: Windows PowerShell 5.1 drops embedded quotes when it
# passes an argument to a native program.)
function Ae-ChezmoiData {
    param([string]$key)
    if (-not (Ae-Have 'chezmoi')) { return '' }
    if ($key -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { return '' }
    $v = & chezmoi execute-template ('{{ .' + $key + ' }}') 2>$null
    if ($LASTEXITCODE -ne 0 -or $v -eq '<no value>') { return '' }
    return [string]$v
}

# Dot-source every *.ps1 in a drop-in directory, in name order, sharing the counters.
# Callers must dot-source this function's result: `foreach ($f in (Ae-Dropins $dir)) { . $f.FullName }`
function Ae-Dropins {
    param([string]$dir)
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $dir -Filter '*.ps1' -File | Sort-Object Name)
}

# Refresh registry additions without discarding a caller's local tool overrides.
function Ae-RefreshPath {
    $parts = @($env:Path.Split(';'))
    foreach ($scope in 'Machine', 'User') {
        $value = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ($value) { $parts += $value.Split(';') }
    }
    $env:Path = ($parts | Where-Object { $_ } | Select-Object -Unique) -join ';'
}
