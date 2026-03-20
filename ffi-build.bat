@echo off
cd /d "%~dp0"

echo Building ifc-lite-ffi...
cargo build --release -p ifc-lite-ffi
if %errorlevel% neq 0 (
    echo FFI build failed!
    pause
    exit /b %errorlevel%
)
echo Copying DLLs...
copy /y target\release\ifc_lite_ffi.dll ..\LINK_EP.LINK_RH\tools\ifc-lite\
copy /y target\release\ifc_lite_ffi.dll ..\bin\Debug\
copy /y target\release\ifc-lite-server.exe ..\LINK_EP.LINK_RH\tools\ifc-lite\
echo FFI build and copy complete. Rebuild in Visual Studio and restart Rhino.
pause
