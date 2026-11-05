# Entry-point library only; call Ae-LoadToken service|account inside a Bypass child. PowerShell 5.1, ASCII only.
function Ae-LoadToken {
    param([string]$Mode)
    if ($Mode -eq 'service' -and -not $env:OP_SERVICE_ACCOUNT_TOKEN) {
        $env:OP_SERVICE_ACCOUNT_TOKEN = [Environment]::GetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN', 'User')
    }
}
