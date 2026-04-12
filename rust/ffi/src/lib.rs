// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C FFI bindings for ifc-lite.
//!
//! Exports functions for use via P/Invoke from C#:
//! - `ifc_lite_parse`: parse an IFC file and return JSON bytes
//! - `ifc_lite_parse_ex`: parse with configurable opening filter
//! - `ifc_lite_free`: free a buffer previously returned by parse functions
//!
//! Build: `cargo build --release -p ifc-lite-ffi`
//! Output: `target/release/ifc_lite_ffi.dll`

use ifc_lite_processing::{
    process_geometry, process_geometry_filtered, OpeningFilterMode, ParseResponse, ProcessingResult,
};
use std::slice;

/// Threshold in meters. If a mesh's first vertex exceeds this magnitude,
/// the mesh is still in world-space and needs the site translation subtracted.
/// Meshes already in site-local space will have coordinates well below this.
const LARGE_COORD_THRESHOLD: f64 = 1000.0;

/// Post-process meshes to ensure all positions are in uniform site-local coordinates.
///
/// The upstream processing pipeline applies RTC (Relative To Center) via a per-mesh
/// heuristic that can leave some meshes in world-space while others are in site-local.
/// This function detects and fixes the inconsistency by subtracting the site placement
/// translation from any mesh still in world-space, using f64 precision to avoid jitter.
fn normalize_to_site_local(result: &mut ProcessingResult) {
    let site_tx: f64;
    let site_ty: f64;
    let site_tz: f64;

    if let Some(ref st) = result.site_transform {
        if st.len() >= 16 {
            // Column-major 4x4: translation at indices 12, 13, 14
            site_tx = st[12];
            site_ty = st[13];
            site_tz = st[14];
        } else {
            return;
        }
    } else {
        return;
    }

    // If site translation is near zero, nothing to normalize
    if site_tx.abs() < LARGE_COORD_THRESHOLD
        && site_ty.abs() < LARGE_COORD_THRESHOLD
        && site_tz.abs() < LARGE_COORD_THRESHOLD
    {
        return;
    }

    for mesh in &mut result.meshes {
        if mesh.positions.len() < 3 {
            continue;
        }

        // Check first vertex to detect coordinate space
        let vx = mesh.positions[0].abs() as f64;
        let vy = mesh.positions[1].abs() as f64;
        let vz = mesh.positions[2].abs() as f64;
        let mag = vx.max(vy).max(vz);

        if mag <= LARGE_COORD_THRESHOLD {
            // Already in site-local space (RTC was applied by upstream pipeline)
            continue;
        }

        // Still in world-space — subtract site translation with f64 precision
        for chunk in mesh.positions.chunks_exact_mut(3) {
            chunk[0] = (chunk[0] as f64 - site_tx) as f32;
            chunk[1] = (chunk[1] as f64 - site_ty) as f32;
            chunk[2] = (chunk[2] as f64 - site_tz) as f32;
        }
    }
}

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
    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    let content = match std::fs::read_to_string(path_str) {
        Ok(c) => c,
        Err(_) => return 2,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_geometry(&content)
    }));

    let mut result = match result {
        Ok(r) => r,
        Err(_) => return 3,
    };

    // Normalize all meshes to uniform site-local coordinates
    normalize_to_site_local(&mut result);

    let response = ParseResponse {
        cache_key: String::new(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
    };

    let json_bytes = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(_) => return 4,
    };

    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
}

/// Parse an IFC file with a configurable opening filter and return JSON bytes.
///
/// # Arguments
/// - `path_ptr` / `path_len`: UTF-8 encoded file path
/// - `opening_filter_mode`: 0 = Default, 1 = IgnoreAll, 2 = IgnoreOpaque
/// - `out_ptr`: receives pointer to allocated JSON bytes
/// - `out_len`: receives length of allocated JSON bytes
///
/// # Returns
/// Same error codes as `ifc_lite_parse`.
///
/// # Safety
/// Caller must free the returned buffer with `ifc_lite_free`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse_ex(
    path_ptr: *const u8,
    path_len: usize,
    opening_filter_mode: i32,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    let content = match std::fs::read_to_string(path_str) {
        Ok(c) => c,
        Err(_) => return 2,
    };

    let mode = match opening_filter_mode {
        1 => OpeningFilterMode::IgnoreAll,
        2 => OpeningFilterMode::IgnoreOpaque,
        _ => OpeningFilterMode::Default,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_geometry_filtered(&content, mode)
    }));

    let mut result = match result {
        Ok(r) => r,
        Err(_) => return 3,
    };

    // Normalize all meshes to uniform site-local coordinates
    normalize_to_site_local(&mut result);

    let response = ParseResponse {
        cache_key: String::new(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
    };

    let json_bytes = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(_) => return 4,
    };

    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
}

/// Free a buffer previously returned by `ifc_lite_parse` or `ifc_lite_parse_ex`.
///
/// # Safety
/// `ptr` and `len` must match a previous return from a parse function.
/// Must not be called more than once for the same buffer.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Box::from_raw(slice::from_raw_parts_mut(ptr, len));
    }
}
