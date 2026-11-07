# 回滚本地主用 Go 网关到切换前的二进制。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\rollback-go-local.ps1 -Backup .tmp\backup-20261107-114254
# 只替换二进制并按 start-go-local.ps1 的参数重启；数据目录不回滚（需要时手动从 <Backup>\data 复制）。
# 旧二进制没有 CORS 跨站拦截，-ConsoleOrigins 对它无影响但无害。
param(
    [Parameter(Mandatory = $true)][string]$Backup
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backupDir = if ([System.IO.Path]::IsPathRooted($Backup)) { $Backup } else { Join-Path $root $Backup }
$oldExe = Join-Path $backupDir 'factorybridge.exe.old'
$target = Join-Path $root 'apps\gateway-go\.tmp\factorybridge.exe'
if (-not (Test-Path $oldExe)) { throw "Backup binary not found: $oldExe" }

$listener = Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue
if ($listener) {
    $procId = $listener[0].OwningProcess
    $path = (Get-Process -Id $procId).Path
    if ($path -ne $target) { throw "Port 18080 is held by $path (PID $procId), not the gateway; refusing to stop it" }
    Stop-Process -Id $procId
    for ($i = 0; $i -lt 10 -and (Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    if (Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue) { Stop-Process -Id $procId -Force; Start-Sleep -Seconds 2 }
}

Copy-Item -Force $oldExe $target
& (Join-Path $PSScriptRoot 'start-go-local.ps1')
