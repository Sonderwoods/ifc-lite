# Fork Overrides & Extensions

A live registry of everything this fork (`Sonderwoods/ifc-lite`) **adds, overrides, or
extends** on top of the original upstream ([`LTplus-AG/ifc-lite`](https://github.com/LTplus-AG/ifc-lite),
also reachable via the `louistrue/ifc-lite` redirect).

**Why this file exists:** these tweaks must survive every `git fetch upstream` + rebase/merge.
`git diff main..net-dll` shows you *what* changed; this file records *why* it changed and
*what to watch when upstream moves* — the part git can't tell you. Update it whenever you add,
change, or drop a divergence.

## Branch model

- `main` — kept clean, an exact mirror of `upstream/main`. Never commit fork work here.
- `net-dll` — the integration branch carrying the overrides below. Sync it by fetching
  `upstream/main` into `main`, then rebasing/merging `net-dll` onto `main`.
- `main_backup` — frozen snapshot of the old pre-cleanup fork main (the v2.1.8 lineage WIP).
  Historical reference only; not part of the sync loop.

## Sync checklist

1. `git fetch upstream && git checkout main && git reset --hard upstream/main`
2. `git checkout net-dll && git rebase main` (or `merge`)
3. For each entry below, re-check its **Upstream-sync watch** notes — a signature or struct
   change upstream is where these overrides break.
4. Rebuild (see each entry's build note) before pushing.

---

## Categories

- **Extension** — adds a capability upstream doesn't have (a new crate, command, or endpoint).
  No change to existing upstream behavior.
- **Override** — changes upstream's *runtime behavior or output* (e.g. a geometry/processing tweak).
- **Maintenance** — build, tooling, or repo housekeeping that keeps the fork buildable and tidy.
  No source/runtime behavior change.

## Registry

| # | Feature | Category | Key paths | Status |
|---|---------|----------|-----------|--------|
| 1 | Native FFI DLL build | Extension | `rust/ffi/`, root `Cargo.toml`, `ffi-build.bat` | Active |
| 2 | Pin `rust/` toolchain for wasm builds | Maintenance | `rust/rust-toolchain.toml` | Active |
| 3 | Ignore local `.bat` build helpers | Maintenance | `.gitignore`, `ffi-build.bat` | Active |

---

### 1. Native FFI DLL build (`ifc-lite-ffi`)

**Category:** Extension — adds a new crate and a build script. Does not alter upstream runtime behavior.

**Why:** Linkajou (the Rhino plugin) loads ifc-lite **in-process** via P/Invoke to parse an IFC
file straight to geometry JSON, without standing up the HTTP server. The DLL is the bridge.

**What it adds / changes:**

- `rust/ffi/` — a `cdylib` crate exposing three `extern "C"` functions for C#:
  - `ifc_lite_parse(path, len, out_ptr, out_len) -> i32`
  - `ifc_lite_parse_ex(path, len, opening_filter_mode, out_ptr, out_len) -> i32`
  - `ifc_lite_free(ptr, len)`
  It calls only the stable `ifc-lite-processing` public API and serializes a `ParseResponse`
  to JSON bytes for the caller to free.
- Root `Cargo.toml` — adds `"rust/ffi"` to `[workspace] members`.
- `ffi-build.bat` — **local-only, intentionally untracked.** Builds the DLL and copies it into
  the sibling `..\Linkajou\LINK_Rhino\...` checkout. It hardcodes machine-relative paths, so it
  is deliberately *not* committed; recreate it locally if you reclone. Build command:
  `cargo build --profile server-release -p ifc-lite-ffi`.

**Build note — use `server-release`, NOT `release`:** upstream's `[profile.release]` sets
`panic = 'abort'` to keep the wasm bundle small. The FFI DLL is loaded in-process by Rhino and
relies on `std::panic::catch_unwind` to turn a parser panic on a malformed IFC into error code
`3` instead of aborting the whole host process. `catch_unwind` only works when panics *unwind*,
so the DLL must be built under `[profile.server-release]` (`inherits = "release"` +
`panic = "unwind"`). Output lands in `target/server-release/ifc_lite_ffi.dll`. Cargo cannot set
the panic strategy per-package, which is why a dedicated profile is the only clean route.

**Adaptation note — `symbolic_data`:** this fork's `ParseResponse` carries a `symbolic_data`
field that the geometry-only FFI path has no source for. The struct literals in
`rust/ffi/src/lib.rs` set it to `Default::default()` (empty). If you ever want 2D symbol data
through the FFI, wire `extract_symbolic_data` into the parse path instead.

**Upstream-sync watch:**
- `ifc-lite-processing` exports the FFI depends on: `process_geometry`, `process_geometry_filtered`,
  `OpeningFilterMode`, `ParseResponse`, `ProcessingResult`. A signature or field change upstream
  breaks `rust/ffi/src/lib.rs`.
- If upstream ever flips `[profile.release]` to `panic = "unwind"`, the `server-release` workaround
  becomes optional (but harmless).
- The `mesh_coordinate_space` / `site_transform` / `building_transform` fields on `ParseResponse`
  are read directly — if upstream renames them, the FFI won't compile.

### 2. Pin `rust/` toolchain to `nightly-2025-11-15` (wasm builds)

**Category:** Maintenance — build configuration. No source/runtime change.

**Why:** The wasm viewer build (`viewer-run.bat` → `wasm-pack build rust/wasm-bindings`) runs
**inside** `rust/`, so it resolves `rust/rust-toolchain.toml` before the root one. Upstream left
that file floating (`channel = "nightly"`), while the root pins `nightly-2025-11-15`. A floating
nightly from 2026-03 carries an LLVM wasm-backend regression that **cannot lower the geometry
kernel's 128-bit SIMD integer comparison** (`ifc_lite_geometry::kernel::fixed::cmp_lex`):

```
rustc-LLVM ERROR: Cannot select: v16i8 = setcc … setne
In function: …ifc_lite_geometry6kernel5fixed7cmp_lex
```

Pinning `rust/rust-toolchain.toml` to `nightly-2025-11-15` (matching root) makes `wasm-pack` use
the known-good compiler. Verified: `ifc-lite-geometry` compiles to `wasm32-unknown-unknown` with
`+simd128` cleanly under the pin.

**Note:** building from the **repo root** always used the good pin already — only directory-local
builds under `rust/` (wasm-pack) hit the floating channel. The two `rust-toolchain.toml` files
should be kept on the same channel.

**Upstream-sync watch:**
- If upstream pins or bumps its toolchain, re-sync both files to whatever upstream uses (verify a
  wasm + `+simd128` build first).
- If a later pinned nightly fixes the LLVM SIMD lowering, this pin can move forward — re-test
  `cmp_lex` codegen to wasm before changing it.
- `.cargo/config.toml` forces `target-feature=+simd128` for `wasm32-unknown-unknown`; that flag is
  what triggers the bad codegen path, so dropping it would also dodge the bug (at a perf cost).

### 3. Ignore local `.bat` build helpers

**Category:** Maintenance — repo housekeeping. No source/runtime change.

**Why:** The Windows `.bat` helpers in this repo (e.g. `ffi-build.bat`) hardcode machine-relative
paths — `ffi-build.bat` copies the DLL into a sibling `..\Linkajou\LINK_Rhino\...` checkout that
only exists on the dev box. They're convenient locally but shouldn't be committed or pushed, so
`*.bat` is added to `.gitignore`.

**Note:** `.gitignore` does not untrack files already tracked upstream. Any `.bat` upstream already
commits (e.g. `server-run.bat`, `viewer-run.bat`) stays tracked and editable; the rule only stops
*new* local helpers like `ffi-build.bat` from being accidentally staged.

**Upstream-sync watch:**
- If upstream starts tracking a new `.bat` you actually want, `git add -f <file>.bat` to force it
  past the ignore rule.

<!-- Add new entries above this line. Keep the table in sync. -->
