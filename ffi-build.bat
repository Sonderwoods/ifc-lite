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
if not exist "..\LINK_Rhino\LINK_EP.Aioli\tools\ifc-lite\" mkdir "..\LINK_Rhino\LINK_EP.Aioli\tools\ifc-lite\"
copy /y target\release\ifc_lite_ffi.dll "..\LINK_Rhino\LINK_EP.Aioli\tools\ifc-lite\"
copy /y target\release\ifc-lite-server.exe "..\LINK_Rhino\LINK_EP.Aioli\tools\ifc-lite\"
copy /y target\release\ifc_lite_ffi.dll "..\LINK_Rhino\bin\Debug\"
if exist "..\LINK_Rhino\bin\Release\" copy /y target\release\ifc_lite_ffi.dll "..\LINK_Rhino\bin\Release\"
echo FFI build and copy complete. Rebuild in Visual Studio and restart Rhino.
pause
