// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CI smoke test for the ifc-lite FFI DLL.
//!
//! Loads the *built* `cdylib` via `libloading` and drives its C ABI exactly the
//! way a CAD host (Rhino/Revit P/Invoke) would. Because it crosses the real ABI
//! boundary instead of linking the FFI crate directly, it catches regressions an
//! in-crate test cannot — most importantly a DLL built without `panic = "unwind"`
//! (the default `release` profile's `panic = 'abort'`), which would *abort this
//! process* on the panic-isolation check below and surface as a CI failure.
//!
//! Usage:
//!   ffi-smoke <path-to-dll> <path-to-sample.ifc>
//!
//! Exit code 0 = all checks passed; 1 = a check failed (with a diagnostic).

use std::path::Path;
use std::process::ExitCode;

/// `ifc_lite_parse(path_ptr, path_len, out_ptr, out_len) -> i32`
type ParseFn = unsafe extern "C" fn(*const u8, usize, *mut *mut u8, *mut usize) -> i32;
/// `ifc_lite_parse_ex(path_ptr, path_len, opening_filter_mode, out_ptr, out_len) -> i32`
type ParseExFn = unsafe extern "C" fn(*const u8, usize, i32, *mut *mut u8, *mut usize) -> i32;
/// `ifc_lite_free(ptr, len)`
type FreeFn = unsafe extern "C" fn(*mut u8, usize);

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (dll_path, ifc_path) = match (args.next(), args.next()) {
        (Some(dll), Some(ifc)) => (dll, ifc),
        _ => {
            eprintln!("usage: ffi-smoke <path-to-dll> <path-to-sample.ifc>");
            return ExitCode::FAILURE;
        }
    };

    if !Path::new(&ifc_path).is_file() {
        eprintln!("FAIL: sample IFC not found: {ifc_path}");
        return ExitCode::FAILURE;
    }

    match run(&dll_path, &ifc_path) {
        Ok(()) => {
            println!("\nAll FFI smoke checks passed.");
            ExitCode::SUCCESS
        }
        Err(msg) => {
            eprintln!("\nFAIL: {msg}");
            ExitCode::FAILURE
        }
    }
}

fn run(dll_path: &str, ifc_path: &str) -> Result<(), String> {
    // SAFETY: loading a trusted, freshly-built DLL and calling its documented
    // C ABI. All raw-pointer use below matches the contract in `rust/ffi`.
    unsafe {
        let lib = libloading::Library::new(dll_path)
            .map_err(|e| format!("could not load DLL '{dll_path}': {e}"))?;

        let parse: libloading::Symbol<ParseFn> = lib
            .get(b"ifc_lite_parse")
            .map_err(|e| format!("missing export ifc_lite_parse: {e}"))?;
        let parse_ex: libloading::Symbol<ParseExFn> = lib
            .get(b"ifc_lite_parse_ex")
            .map_err(|e| format!("missing export ifc_lite_parse_ex: {e}"))?;
        let free: libloading::Symbol<FreeFn> = lib
            .get(b"ifc_lite_free")
            .map_err(|e| format!("missing export ifc_lite_free: {e}"))?;

        println!("Loaded {dll_path} (all three exports resolved).");

        // 1) Null-pointer guard: every pointer null must return code 1, not crash.
        let code = parse(
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if code != 1 {
            return Err(format!("null-pointer guard: expected code 1, got {code}"));
        }
        println!("  [ok] null pointers -> code 1");

        // 2) Unreadable path must return code 2.
        let missing = format!("{ifc_path}.does-not-exist");
        let mut out_ptr: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;
        let code = parse(
            missing.as_ptr(),
            missing.len(),
            &mut out_ptr,
            &mut out_len,
        );
        if code != 2 {
            return Err(format!("missing-file path: expected code 2, got {code}"));
        }
        println!("  [ok] missing file -> code 2");

        // 3) Valid IFC must return code 0 with a non-empty, valid JSON buffer
        //    carrying at least one mesh. Also exercise the panic-isolation path:
        //    a DLL built with panic='abort' aborts the process here.
        let mut out_ptr: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;
        let code = parse_ex(
            ifc_path.as_ptr(),
            ifc_path.len(),
            0, // OpeningFilterMode::Default
            &mut out_ptr,
            &mut out_len,
        );
        if code != 0 {
            return Err(format!("parse of {ifc_path}: expected code 0, got {code}"));
        }
        if out_ptr.is_null() || out_len == 0 {
            return Err("parse returned code 0 but an empty buffer".to_string());
        }

        // Copy the JSON out before freeing the DLL-owned buffer.
        let json_bytes = std::slice::from_raw_parts(out_ptr, out_len).to_vec();
        free(out_ptr, out_len);

        let json: serde_json::Value = serde_json::from_slice(&json_bytes)
            .map_err(|e| format!("returned buffer is not valid JSON: {e}"))?;

        let mesh_count = json
            .get("meshes")
            .and_then(|m| m.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        if mesh_count == 0 {
            return Err("parse succeeded but returned zero meshes".to_string());
        }

        let coord_space = json
            .get("mesh_coordinate_space")
            .and_then(|v| v.as_str())
            .unwrap_or("<unset>");

        // symbolic_data is omitted from JSON when empty (skip_serializing_if).
        let symbol_summary = match json.get("symbolic_data") {
            Some(sd) => {
                let count_of = |key: &str| {
                    sd.get(key).and_then(|v| v.as_array()).map_or(0, |a| a.len())
                };
                format!(
                    "grid_axes={}, polylines={}, circles={}, texts={}, fills={}",
                    count_of("grid_axes"),
                    count_of("polylines"),
                    count_of("circles"),
                    count_of("texts"),
                    count_of("fills"),
                )
            }
            None => "none (empty)".to_string(),
        };

        println!(
            "  [ok] valid IFC -> code 0, {} bytes, {mesh_count} meshes, coord_space={coord_space}",
            json_bytes.len()
        );
        println!("  [info] symbolic_data: {symbol_summary}");
    }

    Ok(())
}
