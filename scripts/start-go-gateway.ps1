# 已废弃（2026-11-07）：参数与实际运行不一致（强制 DRIVER_MODE=go、TDengine 16041），且不设置 CORS。用 scripts/start-go-local.ps1。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$goExe = Join-Path $root 'apps\gateway-go\.tmp\factorybridge.exe'
$goDir = Join-Path $root 'apps\gateway-go\.tmp'
$goLog = Join-Path $goDir 'gateway-go.log'
$goErr = Join-Path $goDir 'gateway-go.err.log'

$listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "Go gateway already listens on http://127.0.0.1:18080 (PID $($listener[0].OwningProcess))"
    exit 0
}

if (-not (Test-Path $goExe)) {
    throw "Go gateway binary not found: $goExe"
}

$env:GATEWAY_GO_PORT = '18080'
$env:GATEWAY_GO_DRIVER_MODE = 'go'
$env:TDENGINE_URL = 'http://127.0.0.1:16041'
$env:TDENGINE_USER = 'root'
$env:TDENGINE_PASSWORD = 'taosdata'

Start-Process -FilePath $goExe -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $goLog -RedirectStandardError $goErr | Out-Null

$listener = $null
for ($attempt = 0; $attempt -lt 15 -and -not $listener; $attempt++) {
    Start-Sleep -Seconds 1
    $listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue
}
if (-not $listener) {
    throw 'Go gateway failed to bind port 18080; inspect apps/gateway-go/.tmp/gateway-go.err.log'
}
Write-Output "Go gateway started on http://127.0.0.1:18080 (PID $($listener[0].OwningProcess))"
