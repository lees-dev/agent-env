# Called inside the preflight/backup/verify -ExecutionPolicy Bypass entry points only.
# Interactive runbook commands inline the User-environment read instead.
function Ae-LoadCpaDir {
    if (-not $env:CPA_APP_DIR) {
        $env:CPA_APP_DIR = [Environment]::GetEnvironmentVariable('CPA_APP_DIR', 'User')
    }
}
