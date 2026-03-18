---
name: ifc-lite dev commands
description: How to build and run the ifc-lite web viewer, HTTP server, FFI DLL, and WASM — including cache clearing. All commands in CMD (bat) syntax.
type: reference
---

## Web Viewer (client-side WASM parsing)

**Build & run:**
```bat
cd C:\Users\mass\GitHub\Linkajou\ifc-lite

REM 1. Rebuild WASM if Rust code changed:
wasm-pack build rust/wasm-bindings --target web --out-dir ../../packages/wasm/pkg

REM 2. Build TS packages + start dev server:
pnpm --filter "./packages/**" build && pnpm --filter viewer dev

```
- Uses `pnpm --filter "./packages/**"` to avoid Windows bash errors from viewer-embed/viewer build scripts
- Vite dev server hot-reloads TS changes automatically — no restart needed for frontend changes
- **Must rebuild WASM** (`wasm-pack build ...`) whenever Rust core/geometry changes, otherwise viewer uses stale `.wasm`

**Rerun after code changes:**
- Rust changes → rerun `wasm-pack build ...` then refresh browser
- TS package changes → restart the `pnpm --filter viewer dev` command
- Viewer UI changes → automatic (Vite HMR)

---

## HTTP Server (Rust, port 8080)

**Build & run:**
```bat
cd C:\Users\mass\GitHub\Linkajou\ifc-lite
cargo build --release -p ifc-lite-server
if exist .cache rmdir /s /q .cache
set PORT=8080
set RUST_LOG=warn
set MAX_FILE_SIZE_MB=2000
set REQUEST_TIMEOUT_SECS=1800
target\release\ifc-lite-server.exe 2>nul

```

**Rerun after Rust changes:**
- `cargo build --release -p ifc-lite-server` then restart the exe
- Cache is auto-cleared on each start by the commands above

---

## FFI DLL (for Rhino plugin)

**Build & copy:**
```bat
cd C:\Users\mass\GitHub\Linkajou\ifc-lite\apps\server
cargo build --release -p ifc-lite-server
cargo build --release -p ifc-lite-ffi
cd C:\Users\mass\GitHub\Linkajou\ifc-lite
copy /y target\release\ifc_lite_ffi.dll ..\LINK_EP.LINK_RH\tools\ifc-lite\
copy /y target\release\ifc_lite_ffi.dll ..\bin/Debug
copy /y target\release\ifc-lite-server.exe ..\LINK_EP.LINK_RH\tools\ifc-lite\

```
- Then **build in Visual Studio** (F5/Debug) — MSBuild post-build copies DLL from `tools\ifc-lite\` → `bin\Debug\`
- Must restart Rhino to pick up new DLL (Rhino locks it in memory)

---

## Cache clearing

| Cache | Command |
|-------|---------|
| Browser cache | `Ctrl+Shift+R` or F12 → Application → Clear site data |
| Browser IndexedDB | F12 → Application → IndexedDB → delete ifc-lite entries |
| Server disk cache | `if exist .cache rmdir /s /q .cache` (included in server start above) |
