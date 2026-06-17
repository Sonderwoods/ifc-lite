<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# `ifc-lite-ffi` — native C ABI for in-process IFC parsing

A `cdylib` that exposes ifc-lite's parser over a tiny C ABI, so CAD hosts
(Rhino, Revit, …) can load it in-process via P/Invoke instead of shelling out to
the local EXE server. Fewer enterprise security warnings, no localhost socket.

## Build (read this first)

```sh
cargo build --profile server-release -p ifc-lite-ffi
```

| Platform | Output |
|----------|--------|
| Windows  | `target/server-release/ifc_lite_ffi.dll` |
| Linux    | `target/server-release/libifc_lite_ffi.so` |
| macOS    | `target/server-release/libifc_lite_ffi.dylib` |

> ⚠️ **`server-release` is mandatory, not a preference.** The workspace default
> `release` profile sets `panic = 'abort'`, which turns the `catch_unwind`
> guards in `src/lib.rs` into no-ops. Built that way, a parser panic **aborts
> the entire host CAD process** instead of returning error code `3`.
> `server-release` inherits `release` but restores `panic = "unwind"`.

## Exported functions

```c
// 0 = OK, 1 = null arg / bad UTF-8 path, 2 = read failed,
// 3 = processing panic (caught), 4 = JSON serialization failed.
int32_t ifc_lite_parse   (const uint8_t* path, uintptr_t path_len,
                          uint8_t** out, uintptr_t* out_len);
int32_t ifc_lite_parse_ex(const uint8_t* path, uintptr_t path_len,
                          int32_t opening_filter_mode,   // 0 Default, 1 IgnoreAll, 2 IgnoreOpaque
                          uint8_t** out, uintptr_t* out_len);
void    ifc_lite_free    (uint8_t* ptr, uintptr_t len);  // free a buffer returned above
```

On success `out`/`out_len` point at a UTF-8 JSON `ParseResponse` (meshes,
transforms, metadata, stats, and 2D `symbolic_data`). The caller **must** return
the buffer to `ifc_lite_free` exactly once.

## Smoke test (`ifc-lite-ffi-smoke`)

`rust/ffi-smoke` is a small console app that **loads the built DLL with
`libloading`** and drives the C ABI the way a real host does. Loading the
artifact (rather than linking the crate) is deliberate: it crosses the real ABI
boundary and is the only way to catch a DLL accidentally built with
`panic = 'abort'` — a same-process test inherits its *own* panic strategy and
would pass against a broken library.

It checks: all three exports resolve, null pointers → `1`, a missing file → `2`,
and a valid IFC → `0` with a non-empty JSON buffer carrying ≥1 mesh (it also
prints the mesh count, coordinate space, and `symbolic_data` summary).

Run it locally (Windows path shown; swap the artifact name per the table above):

```sh
cargo build --profile server-release -p ifc-lite-ffi
cargo run -p ifc-lite-ffi-smoke -- \
  target/server-release/ifc_lite_ffi.dll \
  apps/landing/samples/hello-wall.ifc
```

Expected tail:

```
  [ok] valid IFC -> code 0, 17335 bytes, 8 meshes, coord_space=raw_ifc
  [info] symbolic_data: grid_axes=0, polylines=1, circles=0, texts=0, fills=0
All FFI smoke checks passed.
```

## Calling from CI

Mirrors `.github/workflows/server-binaries.yml`: build with `server-release`,
then run the smoke binary against the artifact and a committed sample. The
shell step resolves the platform-specific library name so the same job works on
Linux/macOS/Windows runners.

```yaml
# .github/workflows/ffi-smoke.yml
name: FFI Smoke
on:
  pull_request:
    paths: ['rust/ffi/**', 'rust/ffi-smoke/**', 'rust/processing/**', 'Cargo.lock', 'Cargo.toml']
permissions:
  contents: read
jobs:
  ffi-smoke:
    name: FFI Smoke (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-14]
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with: { persist-credentials: false }
      - uses: dtolnay/rust-toolchain@3c5f7ea28cd621ae0bf5283f0e981fb97b8a7af9 # master 2026-05
        with: { toolchain: stable }

      - name: Build FFI DLL (server-release — panic=unwind)
        run: cargo build --profile server-release -p ifc-lite-ffi

      - name: Build smoke runner
        run: cargo build -p ifc-lite-ffi-smoke

      - name: Run smoke test against the built artifact
        shell: bash
        run: |
          case "${{ runner.os }}" in
            Windows) LIB=target/server-release/ifc_lite_ffi.dll ;;
            macOS)   LIB=target/server-release/libifc_lite_ffi.dylib ;;
            *)       LIB=target/server-release/libifc_lite_ffi.so ;;
          esac
          SMOKE=target/debug/ffi-smoke
          [ "${{ runner.os }}" = "Windows" ] && SMOKE=target/debug/ffi-smoke.exe
          "$SMOKE" "$LIB" apps/landing/samples/hello-wall.ifc
```

The build step is itself a guard: it fails the job if the DLL doesn't compile,
and the smoke step fails (or the process aborts) if the ABI or panic contract
regresses.

## Calling from C# (P/Invoke sketch)

```csharp
[DllImport("ifc_lite_ffi", CallingConvention = CallingConvention.Cdecl)]
static extern int ifc_lite_parse_ex(byte[] path, nuint pathLen, int filterMode,
                                    out IntPtr outPtr, out nuint outLen);
[DllImport("ifc_lite_ffi", CallingConvention = CallingConvention.Cdecl)]
static extern void ifc_lite_free(IntPtr ptr, nuint len);

var path = Encoding.UTF8.GetBytes(@"C:\models\house.ifc");
int code = ifc_lite_parse_ex(path, (nuint)path.Length, 0, out var ptr, out var len);
if (code != 0) throw new Exception($"ifc-lite parse failed: {code}");
try
{
    var json = new byte[(int)len];
    Marshal.Copy(ptr, json, 0, (int)len);
    // ... deserialize Encoding.UTF8.GetString(json) ...
}
finally { ifc_lite_free(ptr, len); }
```
