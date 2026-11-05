# preflight drop-in (harness): read-only checks that the harness modify_ templates can merge.
#   - the repo's harness settings (home/.chezmoitemplates/harness/config.toml) parse
#   - each harness config that already exists parses as JSON or TOML. A file that does not
#     parse would stop `chezmoi apply`: the modify_ templates never overwrite what they
#     cannot read. FAIL names the file only.
#   - node is on PATH (the pr-workflow hook runs under node)
#   - which inline credential keys the apply will remove (key names only, never values)
# Dot-sourced by scripts/preflight.ps1; never exits. PowerShell 5.1, ASCII only.
# Templates go to chezmoi on stdin: Windows PowerShell 5.1 strips quotes from arguments.

if (-not (Ae-Have 'chezmoi')) {
    Ae-Warn 'harness: chezmoi not installed yet, so the config parse checks are skipped'
} else {
    $aeHOld = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $aeHN = [string]('{{ includeTemplate "harness/config.toml" . | fromToml | len }}' | & chezmoi --source $Repo execute-template 2>$null)
    $aeHRc = $LASTEXITCODE
    if ($aeHRc -eq 0 -and $aeHN -match '^\d+$' -and [int]$aeHN -gt 0) { Ae-Ok "harness: repo settings parse ($aeHN tables)" }
    else { Ae-Fail 'harness: home/.chezmoitemplates/harness/config.toml does not parse' }
    $aeHFiles = @(
        @('.claude/settings.json', 'fromJson'),
        @('.config/muse/settings.json', 'fromJson'),
        @('.t3/userdata/settings.json', 'fromJson'),
        @('.codex/config.toml', 'fromToml'),
        @('.grok/config.toml', 'fromToml'))
    foreach ($aeHF in $aeHFiles) {
        $aeHPath = (Join-Path $HOME $aeHF[0]) -replace '\\', '/'
        if (-not (Test-Path -LiteralPath $aeHPath)) { continue }
        $aeHT = '{{ $_ := include `' + $aeHPath + '` | ' + $aeHF[1] + ' }}ok'
        $null = ($aeHT | & chezmoi execute-template 2>$null)
        if ($LASTEXITCODE -eq 0) { Ae-Ok ('harness: ~/' + $aeHF[0] + ' parses') }
        else { Ae-Fail ('harness: ~/' + $aeHF[0] + ' does not parse; fix it before apply (the merge never overwrites it)') }
    }
    $ErrorActionPreference = $aeHOld
}

if (Ae-Have 'node') { Ae-Ok 'harness: node on PATH (pr-workflow hook)' }
else { Ae-Warn 'harness: node not on PATH; the pr-workflow hook needs it (the packages step installs it)' }

# Inline credentials the apply replaces with the cpa token helper. Key names only.
$aeHN = 0
$aeHP = Join-Path $HOME '.claude/settings.json'
if ((Test-Path -LiteralPath $aeHP) -and (Select-String -LiteralPath $aeHP -SimpleMatch '"ANTHROPIC_AUTH_TOKEN"' -Quiet)) { $aeHN++ }
$aeHP = Join-Path $HOME '.codex/config.toml'
if ((Test-Path -LiteralPath $aeHP) -and (Select-String -LiteralPath $aeHP -SimpleMatch 'experimental_bearer_token' -Quiet)) { $aeHN++ }
if ($aeHN -gt 0) { Ae-Info "harness: $aeHN harness config(s) hold an inline key; apply removes it and points them at the cpa token helper" }
