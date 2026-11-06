$ErrorActionPreference = 'Stop'
$GoOnly = $args -contains '-GoOnly'
$root = 'D:\ai_project\IotConnector'
$goExe = Join-Path $root 'apps\gateway-go\.tmp\factorybridge.exe'
$goLog = Join-Path $root 'apps\gateway-go\.tmp\gateway-go.log'
$goErr = Join-Path $root 'apps\gateway-go\.tmp\gateway-go.err.log'
$nodeEntry = Join-Path $root 'apps\gateway\node_modules\.bin\tsx.cmd'
$nodeLog = Join-Path $root 'apps\gateway\data\gateway-node.log'
$nodeErr = Join-Path $root 'apps\gateway\data\gateway-node.err.log'

$env:GATEWAY_GO_PORT = '18080'
$env:GATEWAY_GO_DRIVER_MODE = 'go'
$env:TDENGINE_URL = 'http://127.0.0.1:16041'
$env:TDENGINE_USER = 'root'
$env:TDENGINE_PASSWORD = 'taosdata'
Start-Process -FilePath $goExe -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $goLog -RedirectStandardError $goErr | Out-Null

if (-not $GoOnly) {
    $env:GATEWAY_PORT = '18081'
    Start-Process -FilePath $nodeEntry -ArgumentList 'src\index.ts' -WorkingDirectory (Join-Path $root 'apps\gateway') -WindowStyle Hidden -RedirectStandardOutput $nodeLog -RedirectStandardError $nodeErr | Out-Null
}

Start-Sleep -Seconds 8
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 18080, 18081 } | Select-Object LocalPort, OwningProcess
