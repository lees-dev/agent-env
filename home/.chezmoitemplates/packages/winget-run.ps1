# Shared winget loop. The entry point supplies $items, $packageRole and $optin.
$common = @('--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
$needOptin = @()
foreach ($it in $items) {
    if ($it.Pin -eq 'skip') { Pk-Say ("{0}: skipped on this machine" -f $it.Name); continue }
    $parts = 3
    if ($it.Match -eq 'minor') { $parts = 2 }
    $probePin = $it.Pin
    if ($it.Name -eq 'java') { $parts = 4; $probePin = $it.ProbePin }
    $want = Pk-Prefix $probePin $parts
    $have = Pk-Version $it.Exe $it.Args
    $haveCmp = ''
    if ($have) { $haveCmp = Pk-Prefix $have $parts }
    $cmp = Pk-Cmp $haveCmp $want
    if ($have -and $cmp -eq 0) { Pk-Say ("{0} {1}" -f $it.Name, $have); continue }
    if ($have -and $cmp -gt 0) { Pk-Say ("{0} {1} is newer than the pin {2}: left as is" -f $it.Name, $have, $it.Pin); continue }
    if ($packageRole -eq 'server' -and $it.Scope -eq 'machine') { Pk-Say ("server: {0} left to administrator" -f $it.Name); continue }
    if (($it.Scope -eq 'machine' -or $it.Scope -eq 'user-optin') -and $optin -ne '1') { $needOptin += ('{0} {1}->{2}' -f $it.Name, $(if ($have) { $have } else { 'none' }), $it.Pin); continue }
    if (Pk-Dry) { Pk-Say ("dry-run: would ensure winget {0} {1} (have {2})" -f $it.Id, $it.Pin, $(if ($have) { $have } else { 'none' })); continue }
    # A command on PATH may belong to an installation WinGet does not manage.
    & winget list --id $it.Id --exact --source winget --accept-source-agreements --disable-interactivity | Out-Null
    $verb = 'install'
    if ($LASTEXITCODE -eq 0) { $verb = 'upgrade' }
    $argv = @($verb, '--id', $it.Id, '--version', $it.Pin) + $common
    if ($it.Scope -eq 'user' -or $it.Scope -eq 'user-optin') { $argv += @('--scope', 'user') }
    Pk-Say ("winget {0} {1} {2}" -f $verb, $it.Id, $it.Pin)
    & winget @argv | Out-Null
    $rc = $LASTEXITCODE
    Pk-RefreshPath
    $have = Pk-Version $it.Exe $it.Args
    if ($have -and (Pk-Cmp (Pk-Prefix $have $parts) $want) -eq 0) {
        $script:PkChanged++
        Pk-Say ("{0} {1} installed" -f $it.Name, $have)
    } else {
        Pk-Fail $it.Name ("{0}: winget {1} exited {2}; now {3}, pin {4}" -f $it.Name, $verb, $rc, $(if ($have) { $have } else { 'missing' }), $it.Pin)
    }
}
if ($needOptin.Count -gt 0) {
    Pk-Say ("{0} per-machine package(s) need the owner's OK (UAC): {1}" -f $needOptin.Count, ($needOptin -join ', '))
    Pk-Say "rerun the apply with `$env:AGENT_ENV_SYSTEM_PACKAGES = '1' from a normal terminal"
}
