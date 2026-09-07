@echo off
rem Factory Bridge 网关注册为 Windows 服务（需管理员权限）
rem 前置：deploy\windows\ 下已放入 WinSW-x64.exe 并重命名为 factory-bridge-gateway.exe
rem       factory-bridge-gateway-service.xml 中路径已按实际部署位置修改

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 请以管理员身份运行本脚本。
    pause & exit /b 1
)

if not exist "%~dp0factory-bridge-gateway.exe" (
    echo [ERROR] 缺少 factory-bridge-gateway.exe（WinSW 包装器）。
    echo         从 https://github.com/winsw/winsw/releases 下载 WinSW-x64.exe
    echo         并重命名为 factory-bridge-gateway.exe 放入 %~dp0
    pause & exit /b 1
)

%~dp0factory-bridge-gateway.exe install
%~dp0factory-bridge-gateway.exe start
sc query factory-bridge-gateway
echo.
echo [OK] 服务已注册并启动。日志位于 %~dp0logs\
pause
