# 已废弃（2026-11-07）：Node 网关已冻结，回滚改为回退到上一个 Go 版本，见 scripts/rollback-go-local.ps1。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$nodeEntry = Join-Path $root 'apps\gateway\node_modules\.bin\tsx.cmd'
$nodeDir = Join-Path $root 'apps\gateway'
$nodeLog = Join-Path $root 'apps\gateway\data\gateway-node.log'
$nodeErr = Join-Path $root 'apps\gateway\data\gateway-node.err.log'

$listener = Get-NetTCPConnection -State Listen -LocalPort 18081 -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "Node rollback gateway already listens on http://127.0.0.1:18081 (PID $($listener[0].OwningProcess))"
    exit 0
}

if (-not (Test-Path $nodeEntry)) {
    throw "Node gateway entry not found: $nodeEntry"
}

$env:GATEWAY_PORT = '18081'
$env:TDENGINE_URL = 'http://127.0.0.1:16041'
$env:TDENGINE_USER = 'root'
$env:TDENGINE_PASSWORD = 'taosdata'

Start-Process -FilePath $nodeEntry -ArgumentList 'src\index.ts' -WorkingDirectory $nodeDir -WindowStyle Hidden -RedirectStandardOutput $nodeLog -RedirectStandardError $nodeErr | Out-Null

$listener = $null
for ($attempt = 0; $attempt -lt 20 -and -not $listener; $attempt++) {
    Start-Sleep -Seconds 1
    $listener = Get-NetTCPConnection -State Listen -LocalPort 18081 -ErrorAction SilentlyContinue
}
if (-not $listener) {
    throw 'Node rollback gateway failed to bind port 18081; inspect apps/gateway/data/gateway-node.err.log'
}
Write-Output "Node rollback gateway started on http://127.0.0.1:18081 (PID $($listener[0].OwningProcess))"
