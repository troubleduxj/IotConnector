# 本地主用 Go 网关（18080）。参数与 2026-11-07 切换前实际运行的实例一致：
#   - 不启用 GATEWAY_GO_DRIVER_MODE=go：未显式指定 params.driver 的通道不建驱动（状态 error）
#   - 不配置 TDENGINE_URL：存储 disabled
# 需要真实采集时传 -DriverModeGo；需要落库时传 -TDengineUrl。
#
# 阶段 1 起网关拒绝跨站写请求（B2），控制台经 Vite 代理访问时 Origin 为控制台地址，
# 必须列入 GATEWAY_GO_CORS_ORIGINS，否则登录返回 403。
param(
    [switch]$DriverModeGo,
    [string]$TDengineUrl = '',
    [string]$TDenginePassword = $env:TDENGINE_PASSWORD,
    [string]$ConsoleOrigins = 'http://localhost:3000,http://127.0.0.1:3000',
    [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$goDir = Join-Path $root 'apps\gateway-go\.tmp'
if (-not $Exe) { $Exe = Join-Path $goDir 'factorybridge.exe' }
$goLog = Join-Path $goDir 'gateway-go.log'
$goErr = Join-Path $goDir 'gateway-go.err.log'

$listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "Go gateway already listens on http://127.0.0.1:18080 (PID $($listener[0].OwningProcess))"
    exit 0
}
if (-not (Test-Path $Exe)) { throw "Go gateway binary not found: $Exe" }

$env:GATEWAY_GO_PORT = '18080'
$env:GATEWAY_GO_CORS_ORIGINS = $ConsoleOrigins
if ($DriverModeGo) { $env:GATEWAY_GO_DRIVER_MODE = 'go' } else { Remove-Item Env:GATEWAY_GO_DRIVER_MODE -ErrorAction SilentlyContinue }
if ($TDengineUrl) {
    if (-not $TDenginePassword) { throw 'Set -TDenginePassword or TDENGINE_PASSWORD when -TDengineUrl is given' }
    $env:TDENGINE_URL = $TDengineUrl
    $env:TDENGINE_PASSWORD = $TDenginePassword
} else {
    Remove-Item Env:TDENGINE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:TDENGINE_PASSWORD -ErrorAction SilentlyContinue
}

# 工作目录必须是仓库根：默认数据目录按相对路径 apps\gateway-go\data 解析（A4）。
# 首次启动时网关会从 apps\gateway\data 复制一份状态过来，旧目录不改动。
Start-Process -FilePath $Exe -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $goLog -RedirectStandardError $goErr | Out-Null

$listener = $null
for ($attempt = 0; $attempt -lt 20 -and -not $listener; $attempt++) {
    Start-Sleep -Seconds 1
    $listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue
}
if (-not $listener) { throw "Go gateway failed to bind port 18080; inspect $goErr" }
Write-Output "Go gateway started on http://127.0.0.1:18080 (PID $($listener[0].OwningProcess))"
