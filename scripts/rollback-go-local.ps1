﻿# 回滚本地主用 Go 网关到切换前的二进制。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\rollback-go-local.ps1 -Backup .tmp\backup-20261107-170814 [-RestoreData]
#
# 默认只换回二进制，并把阶段 2/3 导入时改名的状态文件（*.migrated）改回原名、
# 把 gateway.db 移到一边，旧版本才能读到口令、队列和影子。
# 注意：切换期间新产生的数据只在 gateway.db 里，旧版本读不到；被移开的库保留在
# gateway.db.rolledback-<时间>，需要时可再切回去。
#
# -RestoreData：整个数据目录换回备份时的内容（丢弃切换后的全部变化）。
param(
    [Parameter(Mandatory = $true)][string]$Backup,
    [switch]$RestoreData
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backupDir = if ([System.IO.Path]::IsPathRooted($Backup)) { $Backup } else { Join-Path $root $Backup }
$oldExe = Join-Path $backupDir 'factorybridge.exe.old'
$target = Join-Path $root 'apps\gateway-go\.tmp\factorybridge.exe'
$dataDir = Join-Path $root 'apps\gateway\data'
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

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($RestoreData) {
    $backupData = Join-Path $backupDir 'data'
    if (-not (Test-Path $backupData)) { throw "Backup data directory not found: $backupData" }
    Rename-Item $dataDir "$dataDir.rolledback-$stamp"
    Copy-Item -Recurse $backupData $dataDir
    Write-Output "Data directory restored from backup; previous contents kept at $dataDir.rolledback-$stamp"
} else {
    Get-ChildItem $dataDir -Filter '*.migrated' | ForEach-Object {
        $original = Join-Path $dataDir ($_.Name -replace '\.migrated$', '')
        if (Test-Path $original) {
            Write-Output "Keeping existing $($original | Split-Path -Leaf); skipped $($_.Name)"
        } else {
            Rename-Item $_.FullName $original
            Write-Output "Restored $($_.Name -replace '\.migrated$', '')"
        }
    }
    foreach ($suffix in @('', '-wal', '-shm')) {
        $file = Join-Path $dataDir "gateway.db$suffix"
        if (Test-Path $file) { Rename-Item $file "gateway.db.rolledback-$stamp$suffix" }
    }
}

Copy-Item -Force $oldExe $target
& (Join-Path $PSScriptRoot 'start-go-local.ps1')
