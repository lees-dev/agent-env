# cpa verify (read-only), dot-sourced by scripts/verify.ps1. Windows PowerShell 5.1, ASCII only.
#
# Every machine:
#   1. the deployed key file (~/.config/agent-env/cpa-key) and the token helper (cpa-token.cmd)
#   2. the key read from 1Password at run time (op read) matches what the helper prints
#   3. an authenticated GET <cpaUrl>/v1/models with the 1Password key: HTTP status and model count
#   4. per selected harness: the same GET at the base URL that harness uses, with the helper's
#      token: HTTP status and how many of the hub's models belong to that harness
# Hub only: the serve mount still hides the management API, the client-key roster (remarks
# and counts only) and the rebalancer task.
# The key stays in memory and in the request header only, and is never printed. Never exits.
# Variables: $Repo $Versions $Role $Machine $Harnesses.

function Cpa-Get {
    # Returns @{ Code = '200'|'401'|...|'000'; Ids = @(model ids) }. $token may be ''.
    param([string]$url, [string]$token)
    $r = @{ Code = '000'; Ids = @() }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $req = [Net.HttpWebRequest]::Create($url)
        $req.Method = 'GET'
        $req.Timeout = 20000
        if ($token) { $req.Headers.Add('Authorization', 'Bearer ' + $token) }
        $resp = $null
        try { $resp = $req.GetResponse() } catch [Net.WebException] { $resp = $_.Exception.Response }
        if (-not $resp) { return $r }
        $r.Code = [string][int]$resp.StatusCode
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        $sr.Close(); $resp.Close()
        if ($r.Code -eq '200' -and $body) {
            $j = $body | ConvertFrom-Json
            if ($j.data) { $r.Ids = @($j.data | ForEach-Object { [string]$_.id }) }
        }
    } catch {
        if ($r.Code -eq '000') { return $r }
    }
    return $r
}

function Cpa-Family {
    param([string]$h)
    switch ($h) {
        'claude' { return '^claude' }
        'codex' { return '^(gpt|codex|o[0-9])' }
        'grok' { return '^grok' }
        'muse' { return '^muse' }
    }
    return '^$'
}

$cpaUrl = Ae-ChezmoiData 'cpaUrl'
$cpaVault = Ae-ChezmoiData 'opVault'
$cpaItem = Ae-ChezmoiData 'opCpaItem'
$cpaAnth = Ae-ChezmoiData 'cpaAnthropicBaseUrl'
$cpaOai = Ae-ChezmoiData 'cpaOpenAIBaseUrl'
$cpaKeyFile = Join-Path $HOME '.config\agent-env\cpa-key'
$cpaHelper = Join-Path $HOME '.config\agent-env\cpa-token.cmd'

if (-not $cpaUrl -or -not $cpaItem) {
    Ae-Fail 'cpaUrl/opCpaItem not in chezmoi data: re-run chezmoi init (AGENTS.md step 3)'
} else {
    # 1. Key file and helper. (On Windows, private_ does not set an ACL; the profile's own ACL applies.)
    if ((Test-Path -LiteralPath $cpaKeyFile) -and ((Get-Item -LiteralPath $cpaKeyFile).Length -gt 0)) { Ae-Ok 'key file ~/.config/agent-env/cpa-key present' }
    else { Ae-Fail 'key file ~/.config/agent-env/cpa-key missing or empty'; Ae-Hint 'scripts/backup.ps1, then chezmoi apply --force --no-tty' }
    $cpaTok = ''
    if (Test-Path -LiteralPath $cpaHelper) {
        $cpaTok = ((& cmd.exe /d /c $cpaHelper 2>$null) -join '').Trim()
        if ($cpaTok) { Ae-Ok ("helper ~/.config/agent-env/cpa-token.cmd prints a token ({0} chars)" -f $cpaTok.Length) }
        else { Ae-Fail 'helper ~/.config/agent-env/cpa-token.cmd printed nothing' }
    } else {
        Ae-Fail 'helper ~/.config/agent-env/cpa-token.cmd missing'
    }

    # 2-3. The 1Password key, read now.
    $cpaKey = ''
    if ((Ae-ChezmoiData 'opMode') -eq 'service' -and -not $env:OP_SERVICE_ACCOUNT_TOKEN) {
        Ae-Fail 'service token missing; owner must persist it in the User environment (docs/cpa.md), then rerun'
    } elseif (Ae-Have 'op') {
        $cpaKey = (($null | & op read ('op://' + $cpaVault + '/' + $cpaItem + '/credential') 2>$null) -join '').Trim()
        if ($LASTEXITCODE -ne 0) { $cpaKey = '' }
    }
    if (-not $cpaKey) {
        Ae-Fail ("cannot read op://{0}/{1}/credential now (op missing, not signed in, or no item)" -f $cpaVault, $cpaItem)
        Ae-Hint 'sign in (preflight prints how), or mint the key on the hub (docs/cpa.md)'
    } else {
        if ($cpaTok -and ($cpaTok -ceq $cpaKey)) { Ae-Ok "deployed key matches 1Password item $cpaItem" }
        elseif ($cpaTok) { Ae-Fail "deployed key differs from 1Password item $cpaItem"; Ae-Hint 'scripts/backup.ps1, then chezmoi apply --force --no-tty' }
        $r = Cpa-Get "$cpaUrl/v1/models" $cpaKey
        switch -regex ($r.Code) {
            '^200$' {
                if ($r.Ids.Count -gt 0) { Ae-Ok ("hub {0}/v1/models with the 1Password key: HTTP 200, {1} models" -f $cpaUrl, $r.Ids.Count) }
                else { Ae-Fail "hub $cpaUrl/v1/models: HTTP 200 but no models listed" }
            }
            '^(401|403)$' { Ae-Fail ("hub rejected the key for {0} (HTTP {1}): not registered, or revoked" -f $cpaItem, $r.Code); Ae-Hint "on the hub: py -I ~/.cpa-tools/list_client_keys.py, then docs/cpa.md 'Mint a key'" }
            '^000$' { Ae-Fail "hub $cpaUrl unreachable"; Ae-Hint 'tailscale status; the tailnet grant; is Beast on?' }
            default { Ae-Fail ("hub {0}/v1/models: HTTP {1}" -f $cpaUrl, $r.Code) }
        }
    }

    # 4. Per harness, with the token the harness's helper gives it.
    foreach ($h in $Harnesses) {
        if ($h -eq 'claude') { $u = "$cpaAnth/v1/models" } else { $u = "$cpaOai/models" }
        if (-not $cpaTok) { Ae-Fail "${h}: no token from the helper, hub not probed"; continue }
        $r = Cpa-Get $u $cpaTok
        $n = @($r.Ids | Where-Object { $_ -match (Cpa-Family $h) }).Count
        if ($r.Code -eq '200') {
            if ($n -gt 0) { Ae-Ok ("{0}: {1} HTTP 200, {2} {0} models" -f $h, $u, $n) }
            else { Ae-Warn ("{0}: {1} HTTP 200, but no {0} models on the hub" -f $h, $u) }
        } else {
            Ae-Fail ("{0}: {1} HTTP {2} with the helper's token" -f $h, $u, $r.Code)
        }
    }
    $cpaKey = $null; $cpaTok = $null

    if ($Role -eq 'hub') {
        # Serve must still hide the management API (requests through serve arrive from 127.0.0.1).
        $m = Cpa-Get "$cpaUrl/v8/management/config" ''
        if ($m.Code -eq '404') { Ae-Ok 'management API not served over the tailnet (HTTP 404)' }
        elseif ($m.Code -eq '000') { Ae-Fail "hub URL $cpaUrl unreachable from the hub itself" }
        else { Ae-Fail ("management API answers through {0} (HTTP {1})" -f $cpaUrl, $m.Code); Ae-Hint "docs/cpa.md 'Tailscale serve'" }

        # Client-key roster: remarks and counts only.
        $lk = Join-Path $HOME '.cpa-tools\list_client_keys.py'
        if (Test-Path -LiteralPath $lk) {
            $j = (& py -3 -I $lk --json 2>$null) -join ''
            if ($LASTEXITCODE -eq 0 -and $j) {
                $k = $j | ConvertFrom-Json
                if ($k.in_sync) { Ae-Ok ("client keys: {0} in the GUI config, {1} in the core config, same set" -f $k.gui, $k.core) }
                else { Ae-Fail ("client keys differ between the GUI ({0}) and core ({1}) configs" -f $k.gui, $k.core); Ae-Hint 'restart EasyCLIProxyAPI so it regenerates the core config' }
                if (@($k.remarks) -contains $Machine) { Ae-Ok "this hub's own remark '$Machine' has a key" } else { Ae-Fail "no client key with remark '$Machine' on this hub" }
                if ($k.unnamed -gt 0) { Ae-Warn ("{0} client key(s) have no remark" -f $k.unnamed); Ae-Hint "docs/cpa.md 'Rotate or revoke a key' (name or revoke unnamed keys)" }
                if ((Ae-Have 'op') -and ((Ae-ChezmoiData 'opMode') -ne 'service' -or $env:OP_SERVICE_ACCOUNT_TOKEN)) {
                    # Device keys live in separate vaults; the hub admin can list them all.
                    $titles = ($null | & op item list --format json 2>$null) -join "`n"
                    if ($LASTEXITCODE -eq 0) {
                        $missing = @(@($k.remarks) | Where-Object { $titles -notmatch ('"title":\s*"' + [regex]::Escape('cpa-client-' + $_) + '"') })
                        if ($missing.Count -eq 0) { Ae-Ok ("every remark has a 1Password item cpa-client-<remark> ({0})" -f @($k.remarks).Count) }
                        else { Ae-Warn ("{0} remark(s) have no 1Password item: {1}" -f $missing.Count, ($missing -join ', ')) }
                    } else { Ae-Fail 'cannot list client-key items across hub-accessible vaults' }
                    $titles = $null
                }
            } else {
                Ae-Fail 'list_client_keys.py failed'; Ae-Hint 'py -I ~/.cpa-tools/list_client_keys.py'
            }
        } else {
            Ae-Fail '~/.cpa-tools/list_client_keys.py missing'
        }

        # Rebalancer task.
        $privateScript = Join-Path $HOME '.cpa-tools\soonest_reset.py'
        if (-not (Test-Path -LiteralPath $privateScript -PathType Leaf)) {
            Ae-Warn "private rebalancer missing; restore it from the owner's private backup"
        } else {
            $t = Get-ScheduledTask -TaskName 'CPA Soonest-Reset Rebalancer' -TaskPath '\' -ErrorAction SilentlyContinue
            if ($t) {
                $i = Get-ScheduledTaskInfo -InputObject $t
                $age = ((Get-Date) - $i.LastRunTime).TotalMinutes
                if ($t.State -eq 'Disabled') { Ae-Fail 'rebalancer task is disabled' }
                elseif ($i.LastTaskResult -eq 0 -and $age -lt 20) { Ae-Ok ("rebalancer task ran {0:N0} min ago, result 0" -f $age) }
                elseif ($i.LastTaskResult -eq 267009) { Ae-Ok 'rebalancer task is running now' }
                else { Ae-Warn ("rebalancer task last result {0}, {1:N0} min ago" -f $i.LastTaskResult, $age); Ae-Hint "consult the owner's private backup instructions; never report private tool output" }
            } else {
                Ae-Fail 'rebalancer task missing'; Ae-Hint 'rerun run_onchange_after_40-cpa-rebalancer-task after restoring the private script'
            }
        }

    }
}
$cpaUrl = $null; $cpaVault = $null; $cpaItem = $null; $cpaAnth = $null; $cpaOai = $null
