# Helpers for the packages run_ scripts on Windows. chezmoi pastes this file into each script
# with the template action for "packages/lib.ps1". It must contain no template actions, so scripts/check.sh
# parses it as plain PowerShell. Windows PowerShell 5.1 compatible, ASCII only.
#
# Output: names, versions and counts only. $env:AGENT_ENV_DRY_RUN = '1' prints what would
# change and changes nothing.

$script:PkChanged = 0
$script:PkFailed = 0
$script:PkFailedNames = @()

function Pk-Say  { param([string]$m) Write-Host "packages: $m" }
function Pk-Fail { param([string]$name, [string]$m) $script:PkFailed++; $script:PkFailedNames += $name; Write-Host "packages: FAIL $m" }
function Pk-Dry  { return ($env:AGENT_ENV_DRY_RUN -eq '1') }

function Pk-Finish {
    param([string]$name)
    $names = ''
    if ($script:PkFailedNames.Count -gt 0) { $names = ' (' + ($script:PkFailedNames -join ' ') + ')' }
    Pk-Say ("{0}: {1} changed, {2} failed{3}" -f $name, $script:PkChanged, $script:PkFailed, $names)
    if ($script:PkFailed -gt 0) { exit 1 }
    exit 0
}

# Refuse to run inside the Claude desktop app (an MSIX package): Windows would silently
# redirect writes under %APPDATA% and %LOCALAPPDATA% into the package, so installs would land
# where no normal shell sees them. Walk the parent processes looking for the package path.
function Pk-AssertNotMsix {
    $procId = $PID
    for ($i = 0; $i -lt 16 -and $procId; $i++) {
        $p = $null
        try { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop } catch { break }
        if (-not $p) { break }
        if ($p.ExecutablePath -and $p.ExecutablePath -match '\\WindowsApps\\Claude_') {
            Write-Host 'packages: FAIL running under the Claude desktop app (MSIX): installs would be redirected into the package'
            Write-Host 'packages: run chezmoi apply from a normal terminal (Windows Terminal, PowerShell or Git Bash)'
            exit 1
        }
        $procId = $p.ParentProcessId
    }
}

# Rebuild $env:Path from the registry (machine, then user), keeping this process's extra
# entries, so tools installed by an earlier script (or by winget a moment ago) resolve now.
function Pk-RefreshPath {
    $parts = @()
    foreach ($scope in 'Machine', 'User') {
        $v = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ($v) { $parts += $v.Split(';') }
    }
    $parts += $env:Path.Split(';')
    $seen = @{}
    $out = @()
    foreach ($p in $parts) {
        if (-not $p) { continue }
        $k = $p.TrimEnd('\').ToLowerInvariant()
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        $out += $p
    }
    $env:Path = $out -join ';'
}

function Pk-Semver {
    param([string]$text)
    $m = [regex]::Match([string]$text, '(\d+\.\d+\.\d+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# First x.y.z printed by a command line ('' when the command is missing or fails).
function Pk-Version {
    param([string]$exe, [string[]]$argv)
    if (-not (Test-Path -LiteralPath $exe) -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) { return '' }
    try {
        $out = ($null | & $exe @argv 2>$null | Select-Object -First 5) -join "`n"
    } catch { return '' }
    return (Pk-Semver $out)
}

# Compare two dotted versions numerically: -1, 0 or 1 ('' sorts lowest).
function Pk-Cmp {
    param([string]$a, [string]$b)
    if (-not $a) { return -1 }
    $x = $a.Split('.'); $y = $b.Split('.')
    $n = [Math]::Max($x.Count, $y.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $xi = 0; $yi = 0
        if ($i -lt $x.Count) { [void][int]::TryParse($x[$i], [ref]$xi) }
        if ($i -lt $y.Count) { [void][int]::TryParse($y[$i], [ref]$yi) }
        if ($xi -lt $yi) { return -1 }
        if ($xi -gt $yi) { return 1 }
    }
    return 0
}

# The first n dot-separated parts of a version.
function Pk-Prefix {
    param([string]$v, [int]$n)
    return (($v.Split('.') | Select-Object -First $n) -join '.')
}

# Download a vendor installer over HTTPS to a fresh temp file and return its path.
function Pk-GetInstaller {
    param([string]$name, [string]$url)
    if (-not $url.StartsWith('https://')) { throw "refusing non-https URL for $name" }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('agent-env-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $path = Join-Path $dir "$name-install.ps1"
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing -TimeoutSec 300 }
    finally { $ProgressPreference = $old }
    return $path
}

# Run a downloaded .ps1 installer in a child Windows PowerShell, so its own `exit` calls and
# preference changes cannot end or alter this script. Returns the child's exit code.
function Pk-RunInstaller {
    param([string]$path, [string[]]$argv)
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $path @argv | Out-Host
    $rc = $LASTEXITCODE
    Remove-Item -LiteralPath (Split-Path -Parent $path) -Recurse -Force -ErrorAction SilentlyContinue
    return $rc
}
