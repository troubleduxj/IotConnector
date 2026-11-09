@echo off
rem 已废弃：Node 网关已于 2026-11-09 删除，本文件仅作历史参考；Windows 请使用 `factorybridge service install`。
rem Factory Bridge 网关卸载 Windows 服务（需管理员权限）
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 请以管理员身份运行本脚本。
    pause & exit /b 1
)
%~dp0factory-bridge-gateway.exe stop
%~dp0factory-bridge-gateway.exe uninstall
echo [OK] 服务已停止并卸载（data\ 与 logs\ 目录保留）。
pause
