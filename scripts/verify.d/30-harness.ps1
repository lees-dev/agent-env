# verify drop-in (harness): every chosen harness points at the hub, gets its key from the cpa
# token helper, carries no plaintext key, and has its hook, plugins and MCP servers.
# The checks live in 30-harness.checks.tmpl, shared with 30-harness.sh: chezmoi renders it
# with this machine's data and each output line becomes one check. The template goes in on
# stdin because Windows PowerShell 5.1 strips double quotes from native arguments.
# Read-only; dot-sourced by scripts/verify.ps1, so it never exits. PowerShell 5.1, ASCII only.

$aeHarnessTmpl = Join-Path $PSScriptRoot '30-harness.checks.tmpl'
$aeHarnessOut = @()
$aeHarnessOld = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$aeHarnessOut = @([System.IO.File]::ReadAllText($aeHarnessTmpl) | & chezmoi execute-template 2>$null)
$aeHarnessRc = $LASTEXITCODE
$ErrorActionPreference = $aeHarnessOld
if ($aeHarnessRc -ne 0) {
    $aeHarnessOut = @('FAIL harness checks could not run: a harness config does not parse as JSON/TOML',
                      'HINT run scripts/preflight.ps1, which names the file')
}
foreach ($aeHarnessLine in $aeHarnessOut) {
    $l = [string]$aeHarnessLine
    if ($l.StartsWith('OK ')) { Ae-Ok $l.Substring(3) }
    elseif ($l.StartsWith('WARN ')) { Ae-Warn $l.Substring(5) }
    elseif ($l.StartsWith('FAIL ')) { Ae-Fail $l.Substring(5) }
    elseif ($l.StartsWith('HINT ')) { Ae-Hint $l.Substring(5) }
    elseif ($l.StartsWith('INFO ')) { Ae-Info $l.Substring(5) }
}
