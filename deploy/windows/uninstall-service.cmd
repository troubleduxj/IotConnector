@echo off
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
