@echo off
echo Killing ifc-lite-server...
taskkill /IM ifc-lite-server.exe /F 2>nul
if %errorlevel% equ 0 (
    echo Server stopped.
) else (
    echo Server was not running.
)
pause
