// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C FFI bindings for ifc-lite.
//!
//! Exports two functions for use via P/Invoke from C#:
//! - `ifc_lite_parse`: parse an IFC file and return JSON bytes
//! - `ifc_lite_free`: free a buffer previously returned by `ifc_lite_parse`
//!
//! Build: `cargo build --release -p ifc-lite-ffi`
//! Output: `target/release/ifc_lite_ffi.dll`

use ifc_lite_processing::{process_geometry, ParseResponse};
use std::slice;

/// Parse an IFC file and return JSON bytes.
///
/// # Arguments
/// - `path_ptr` / `path_len`: UTF-8 encoded file path
/// - `out_ptr`: receives pointer to allocated JSON bytes
/// - `out_len`: receives length of allocated JSON bytes
///
/// # Returns
/// - `0` on success
/// - `1` if the path is invalid UTF-8
/// - `2` if the file cannot be read
/// - `3` if geometry processing fails
/// - `4` if JSON serialization fails
///
/// # Safety
/// Caller must free the returned buffer with `ifc_lite_free`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse(
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    // Decode path
    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    // Read file
    let content = match std::fs::read_to_string(path_str) {
        Ok(c) => c,
        Err(_) => return 2,
    };

    // Process geometry
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_geometry(&content)
    }));

    let result = match result {
        Ok(r) => r,
        Err(_) => return 3,
    };

    // Build response matching server's ParseResponse JSON shape
    let response = ParseResponse {
        cache_key: String::new(),
        meshes: result.meshes,
        metadata: result.metadata,
        stats: result.stats,
    };

    // Serialize to JSON
    let json_bytes = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(_) => return 4,
    };

    // Allocate and copy to caller
    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
}

/// Free a buffer previously returned by `ifc_lite_parse`.
///
/// # Safety
/// `ptr` and `len` must match a previous return from `ifc_lite_parse`.
/// Must not be called more than once for the same buffer.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        // Reconstruct the boxed slice and drop it
        let _ = Box::from_raw(slice::from_raw_parts_mut(ptr, len));
    }
}
