@echo off
cd /d "%~dp0"
echo Building ifc-lite-server...
cargo build --release -p ifc-lite-server
if %errorlevel% neq 0 (
    echo Build failed!
    pause
    exit /b %errorlevel%
)
echo Clearing cache...
if exist .cache rmdir /s /q .cache
set PORT=8080
set RUST_LOG=warn
set MAX_FILE_SIZE_MB=2000
set REQUEST_TIMEOUT_SECS=1800
echo Starting server on port %PORT%...
target\release\ifc-lite-server.exe 2>nul
pause
