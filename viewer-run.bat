@echo off
cd /d "%~dp0"
echo Building WASM bindings...
wasm-pack build rust/wasm-bindings --target web --out-dir ../../packages/wasm/pkg
if %errorlevel% neq 0 (
    echo WASM build failed!
    pause
    exit /b %errorlevel%
)
echo Building TS packages and starting viewer...
pnpm --filter "./packages/**" build && pnpm --filter viewer dev
pause
