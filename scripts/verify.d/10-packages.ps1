# packages verify (Windows). Dot-sourced by scripts/verify.ps1: read-only, never exits.
# Uses $Repo $Versions $Role $Machine $Harnesses and the Ae-* helpers. PowerShell 5.1, ASCII.
#
# It rebuilds $env:Path from the registry first, so the checks see PATH the way a new
# terminal will, even when the agent's own shell started before the apply.

. (Join-Path $Repo 'home\.chezmoitemplates\packages\lib.ps1')
$pkLocal = Join-Path $HOME '.config\agent-env\versions.local.toml'
function Pk-PinOf {
    param([string]$area, [string]$name, [string]$key)
    $overrideName = $name
    if ($name -eq 'java' -and $key -eq 'winget') { $overrideName = 'java_winget' }
    if (Test-Path -LiteralPath $pkLocal) {
        $v = Ae-TomlGet $pkLocal 'overrides' $overrideName
        if ($v) { return $v }
    }
    $o = Ae-TomlGet $Versions "overrides.$Machine" $overrideName
    if ($o) { return $o }
    if ($key) { $w = Ae-TomlGet $Versions "$area.$name" $key; if ($w) { return $w } }
    return (Ae-TomlGet $Versions "$area.$name" 'version')
}

$pkParts = @()
foreach ($s in 'Machine', 'User') { $v = [Environment]::GetEnvironmentVariable('Path', $s); if ($v) { $pkParts += $v.Split(';') } }
$env:Path = (($pkParts + $env:Path.Split(';')) | Where-Object { $_ } | Select-Object -Unique) -join ';'
Pk-RefreshPath

# winget.txt tools at their pins.
foreach ($l in [IO.File]::ReadAllLines((Join-Path $Repo 'packages\winget.txt'))) {
    $t = ($l -replace '#.*$', '').Trim()
    if (-not $t) { continue }
    $c = @($t.Split('|') | ForEach-Object { $_.Trim() })
    $name = $c[1]; $probe = $c[2].Split(' '); $scope = $c[3]; $match = $c[4]
    if ($c.Count -ge 6 -and $Role -eq 'server') { continue }
    if ((Pk-PinOf 'tools' $name '') -eq 'skip') { Ae-Info "$name skipped on this machine"; continue }
    $desktop = $c.Count -ge 6 -and $c[5] -eq 'desktop'
    $pin = Pk-PinOf 'tools' $name 'winget'
    if ($pin -eq 'skip') { Ae-Info "$name skipped on this machine"; continue }
    $n = 3; if ($match -eq 'minor') { $n = 2 }
    # Java reports runtime 25.0.4.1, not WinGet's MSI ID 25.0.4.101.
    # Pk-Version preserves its fourth component; 25.0.4 is a different runtime.
    if ($name -eq 'java') { $n = 4; $pin = Pk-PinOf 'tools' 'java' '' }
    $want = (($pin.Split('.') | Select-Object -First $n) -join '.')
    $rest = @(); if ($probe.Count -gt 1) { $rest = $probe[1..($probe.Count - 1)] }
    $have = Pk-Version $probe[0] $rest
    $haveN = ''
    if ($have) { $haveN = (($have.Split('.') | Select-Object -First $n) -join '.') }
    if ($haveN -eq $want) { Ae-Ok "$name $have" }
    elseif (-not $have -and $scope -eq 'machine') { Ae-Fail "$name not installed (per-machine: needs AGENT_ENV_SYSTEM_PACKAGES=1 and UAC)" }
    elseif (-not $have) { Ae-Fail "$name not installed (pin $pin)" }
    elseif ($desktop -and (Pk-Cmp $haveN $want) -gt 0) { Ae-Warn "$name $have, pin $pin (self-updated)" }
    elseif ($desktop) { Ae-Fail "$name $have is older than pin $pin" }
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

# Maven, Java environment, and shared npm globals.
$pkMaven = Pk-PinOf 'tools' 'maven' ''
$pkHave = Pk-Version 'mvn.cmd' @('--version')
if ($pkMaven -eq 'skip') { Ae-Info 'maven skipped' }
elseif ($pkHave -eq $pkMaven) { Ae-Ok "maven $pkHave" }
else { Ae-Fail 'maven missing or off pin' }
$pkJavaHome = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
if (-not $pkJavaHome) { $pkJavaHome = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine') }
if ((Pk-PinOf 'tools' 'java' '') -eq 'skip') { Ae-Info 'JAVA_HOME check skipped' }
elseif ($pkJavaHome -and (Test-Path -LiteralPath (Join-Path $pkJavaHome 'bin\javac.exe'))) { Ae-Ok 'JAVA_HOME points to a JDK' }
else { Ae-Fail 'JAVA_HOME missing or not a JDK' }
foreach ($line in [IO.File]::ReadAllLines((Join-Path $Repo 'packages\npm-global.txt'))) {
    $text = ($line -replace '#.*$', '').Trim(); if (-not $text) { continue }
    $c = @($text.Split('|') | ForEach-Object { $_.Trim() })
    if ($c[3] -ne '-' -and $Harnesses -notcontains $c[3]) { continue }
    $ref = $c[1].Split('.')
    $key = 'version'; if ($ref[0] -eq 'skills') { $key = 'cli_version' }
    $pin = Pk-PinOf $ref[0] $ref[1] $key
    if ($pin -eq 'skip') { Ae-Info ($c[2] + ' skipped'); continue }
    $have = ''
    $manifest = Join-Path (Join-Path $env:APPDATA 'npm\node_modules') ($c[0] + '\package.json')
    try { $have = ([IO.File]::ReadAllText($manifest) | ConvertFrom-Json).version } catch { }
    if ($have -eq $pin -and (Get-Command ($c[2] + '.cmd') -ErrorAction SilentlyContinue)) { Ae-Ok ($c[2] + ' ' + $have) }
    else { Ae-Fail ($c[2] + ' missing, off pin or not on PATH') }
}
Remove-Item Function:\Pk-PinOf -ErrorAction SilentlyContinue
Remove-Variable pkLocal, pkParts, pkPy, pkExe, pkWhere, pkRc -ErrorAction SilentlyContinue
