@echo off
cd /d "%~dp0"
echo Building ifc-lite-server...
cargo build --release -p ifc-lite-server
if %errorlevel% neq 0 (
    echo Build failed!
    pause
    exit /b %errorlevel%
)
echo Server build complete.
pause
