# packages verify (Windows). Dot-sourced by scripts/verify.ps1: read-only, never exits.
# Uses $Repo $Versions $Role $Machine $Harnesses and the Ae-* helpers. PowerShell 5.1, ASCII.
#
# It rebuilds $env:Path from the registry first, so the checks see PATH the way a new
# terminal will, even when the agent's own shell started before the apply.

$pkLocal = Join-Path $HOME '.config\agent-env\versions.local.toml'
function Pk-PinOf {
    param([string]$area, [string]$name, [string]$key)
    if (Test-Path -LiteralPath $pkLocal) {
        $v = Ae-TomlGet $pkLocal 'overrides' $name
        if ($v) { return $v }
    }
    $o = Ae-TomlGet $Versions "overrides.$Machine" $name
    if ($o) { return $o }
    if ($key) { $w = Ae-TomlGet $Versions "$area.$name" $key; if ($w) { return $w } }
    return (Ae-TomlGet $Versions "$area.$name" 'version')
}

$pkParts = @()
foreach ($s in 'Machine', 'User') { $v = [Environment]::GetEnvironmentVariable('Path', $s); if ($v) { $pkParts += $v.Split(';') } }
$env:Path = (($pkParts + $env:Path.Split(';')) | Where-Object { $_ } | Select-Object -Unique) -join ';'

# winget.txt tools at their pins.
foreach ($l in [IO.File]::ReadAllLines((Join-Path $Repo 'packages\winget.txt'))) {
    $t = ($l -replace '#.*$', '').Trim()
    if (-not $t) { continue }
    $c = @($t.Split('|') | ForEach-Object { $_.Trim() })
    $name = $c[1]; $probe = $c[2].Split(' '); $scope = $c[3]; $match = $c[4]
    $pin = Pk-PinOf 'tools' $name 'winget'
    if ($pin -eq 'skip') { Ae-Info "$name skipped on this machine"; continue }
    $n = 3; if ($match -eq 'minor') { $n = 2 }
    $want = (($pin.Split('.') | Select-Object -First $n) -join '.')
    $have = ''
    if (Get-Command $probe[0] -ErrorAction SilentlyContinue) {
        $rest = @(); if ($probe.Count -gt 1) { $rest = $probe[1..($probe.Count - 1)] }
        $have = Ae-Semver (($null | & $probe[0] @rest 2>$null | Select-Object -First 5) -join ' ')
    }
    $haveN = ''
    if ($have) { $haveN = (($have.Split('.') | Select-Object -First $n) -join '.') }
    if ($haveN -eq $want) { Ae-Ok "$name $have" }
    elseif (-not $have -and $scope -eq 'machine') { Ae-Fail "$name not installed (per-machine: needs AGENT_ENV_SYSTEM_PACKAGES=1 and UAC)" }
    elseif (-not $have) { Ae-Fail "$name not installed (pin $pin)" }
    elseif ($scope -eq 'machine') { Ae-Warn "$name $have, pin $pin (per-machine; the opt-in apply upgrades it)" }
    else { Ae-Fail "$name $have, pin $pin" }
}

# Python 3.12 through uv.
$pkPy = Ae-TomlGet $Versions 'tools.python312' 'minor'
$pkExe = Join-Path $env:USERPROFILE ".local\bin\python$pkPy.exe"
if (Test-Path -LiteralPath $pkExe) { Ae-Ok ("python{0} {1} (uv)" -f $pkPy, (Ae-Semver (& $pkExe --version 2>$null))) }
else { Ae-Fail "python$pkPy missing from ~\.local\bin (uv python install $pkPy)" }

# Where each harness resolves (base verify checks their versions).
$pkWhere = @{
    'claude' = (Join-Path $env:USERPROFILE '.local\bin\claude.exe')
    'codex'  = (Join-Path $env:APPDATA 'npm\codex')
    'grok'   = (Join-Path $env:USERPROFILE '.grok\bin\grok.exe')
    'muse'   = (Join-Path $env:LOCALAPPDATA 'Programs\muse\muse.cmd')
}
foreach ($h in $Harnesses) {
    if (-not $pkWhere.ContainsKey($h)) { continue }
    $g = Get-Command $h -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $g) { Ae-Fail "$h not on PATH in a new terminal"; continue }
    if ($g.Source -like ($pkWhere[$h] + '*')) { Ae-Ok "$h resolves to the vendor install" }
    else { Ae-Warn ("{0} resolves to {1}, expected {2}" -f $h, $g.Source.Replace($env:USERPROFILE, '~'), $pkWhere[$h].Replace($env:USERPROFILE, '~')) }
}

# Git Bash: the agent-env block, and the muse forwarder.
$pkRc = Join-Path $HOME '.bashrc'
if ((Test-Path -LiteralPath $pkRc) -and ([IO.File]::ReadAllText($pkRc).Contains('# >>> agent-env >>>'))) { Ae-Ok 'Git Bash ~/.bashrc sources env.sh' }
else { Ae-Fail 'Git Bash ~/.bashrc lacks the agent-env block'; Ae-Hint 'run_onchange_before_10-packages-path adds it on apply' }
if ($Harnesses -contains 'muse') {
    if (Test-Path -LiteralPath (Join-Path $HOME '.config\agent-env\gitbash-bin\muse')) { Ae-Ok 'Git Bash muse forwarder present' }
    else { Ae-Fail 'Git Bash muse forwarder missing (~/.config/agent-env/gitbash-bin/muse)' }
}
Remove-Variable pkLocal, pkParts, pkPy, pkExe, pkWhere, pkRc -ErrorAction SilentlyContinue
Remove-Item Function:\Pk-PinOf -ErrorAction SilentlyContinue
