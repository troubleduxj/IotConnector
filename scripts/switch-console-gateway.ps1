param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('go', 'node')]
    [string]$Target
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$consoleDir = Join-Path $root 'apps\console'
$viteEntry = Join-Path $consoleDir 'node_modules\.bin\vite.cmd'
$targetUrl = if ($Target -eq 'go') { 'http://127.0.0.1:18080' } else { 'http://127.0.0.1:18081' }

$listener = Get-NetTCPConnection -State Listen -LocalPort 32123 -ErrorAction SilentlyContinue
if ($listener) {
    $ownerIds = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($ownerId in $ownerIds) {
        Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

$env:VITE_GATEWAY_URL = $targetUrl
Start-Process -FilePath $viteEntry -ArgumentList '--port', '32123', '--host', '0.0.0.0' -WorkingDirectory $consoleDir -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 5

$listener = Get-NetTCPConnection -State Listen -LocalPort 32123 -ErrorAction SilentlyContinue
if (-not $listener) {
    throw "Console failed to bind port 32123 for target $Target"
}
Write-Output "Console proxy switched to $Target ($targetUrl), PID $($listener[0].OwningProcess)"
