# IFC-Lite in Rhino: A Native Desktop Implementation

> **Audience:** IFC-Lite users looking for inspiration on how to integrate IFC-Lite into a native desktop application via FFI.
> **Context:** This documents how we integrated IFC-Lite into a Rhino 3D plugin (C#/.NET) using both the native FFI DLL and the HTTP server. The Rhino/plugin code itself is proprietary, but the IFC-Lite changes and integration patterns are fully described here.

---

## Why IFC-Lite?

We needed a fast, reliable IFC parser for our Rhino plugin. Previously we relied on heavier C++ libraries, but IFC-Lite's Rust core offered significantly better performance with a much smaller footprint. A typical 50MB IFC file parses in under 2 seconds via the FFI path, with zero external dependencies beyond the single DLL.

The key selling point: IFC-Lite already did the hard geometry work (tessellation, boolean operations, coordinate transforms). We just needed to get the triangulated meshes into Rhino.

---

## What We Added to IFC-Lite (Fork Changes)

Our fork ([Sonderwoods/ifc-lite](https://github.com/Sonderwoods/ifc-lite)) adds three things on top of upstream ([louistrue/ifc-lite](https://github.com/louistrue/ifc-lite)):

### 1. The `rust/ffi/` Crate (New)

A `cdylib` crate that compiles to `ifc_lite_ffi.dll` — the native entry point for any non-Rust consumer. This was the critical missing piece: upstream had WASM bindings and an HTTP server, but no C FFI for desktop apps.

**Three exported functions:**

```c
// Parse an IFC file, return JSON bytes
int ifc_lite_parse(
    const uint8_t* path_ptr, size_t path_len,
    uint8_t** out_ptr, size_t* out_len
);

// Parse with configurable window/door filtering
int ifc_lite_parse_ex(
    const uint8_t* path_ptr, size_t path_len,
    int opening_filter_mode,     // 0=Default, 1=IgnoreAll, 2=IgnoreOpaque
    uint8_t** out_ptr, size_t* out_len
);

// Free the buffer returned by parse functions
void ifc_lite_free(uint8_t* ptr, size_t len);
```

Error codes: `0` = success, `1` = bad UTF-8, `2` = file read error, `3` = geometry processing failure, `4` = JSON serialization failure.

The caller gets back a JSON blob matching the same schema as the HTTP server's `/api/v1/parse` endpoint — same `ParseResponse` shape, same mesh format. This means you can swap between FFI and server mode without changing your deserialization code.

### 2. The `rust/processing/` Crate (New)

We extracted the shared processing pipeline into its own crate so both the FFI library and the HTTP server use identical logic. This crate contains:

- **`process_geometry(content)`** — the main entry point, parses IFC content and returns tessellated meshes with metadata
- **`process_geometry_filtered(content, mode)`** — same, but with an `OpeningFilterMode` parameter
- **`OpeningFilterMode`** enum: `Default`, `IgnoreAll`, `IgnoreOpaque`
- **Site-local coordinate output** — meshes come back in site-local coordinates with the site/building transforms returned separately as column-major 4x4 matrices

The processing pipeline does a single-pass entity scan, builds a void index (for boolean subtraction of openings from walls), resolves styles/colors/materials, and then farms out geometry extraction to Rayon's thread pool.

### 3. Geometry Engine Tweaks

A few targeted changes to the upstream geometry crates:

- **Profile void skipping** (`profiles.rs`): Added a `skip_profile_voids` option to `ProfileProcessor`. When `OpeningFilterMode::IgnoreAll` is active, inner curves in `IfcArbitraryProfileDefWithVoids` are ignored. This handles the Revit export pattern where window/door openings are baked directly into the wall's 2D profile rather than using `IfcRelVoidsElement`.

- **Router extensions** (`router/mod.rs`): Added `GeometryRouter::with_scale_rtc_and_skip_voids()` constructor and `resolve_scaled_placement()` for extracting site/building transforms as 4x4 matrices.

- **Arc trim fix** (`profiles.rs`): Simplified the trimmed-curve angle wrapping logic that was causing issues with certain arc geometries.

---

## The FFI Integration Pattern

### How We Call It from C# (P/Invoke)

The C# wrapper is straightforward unsafe P/Invoke. The key design decisions:

```csharp
internal static unsafe class IfcLiteNative
{
    private const string DllName = "ifc_lite_ffi";

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    private static extern int ifc_lite_parse(
        byte* pathPtr, nuint pathLen,
        out byte* outPtr, out nuint outLen);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    private static extern int ifc_lite_parse_ex(
        byte* pathPtr, nuint pathLen,
        int openingFilterMode,
        out byte* outPtr, out nuint outLen);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    private static extern void ifc_lite_free(byte* ptr, nuint len);
}
```

**The public API** is a single method:

```csharp
public static IfcLiteParseResponse ParseIfc(
    string ifcPath,
    OpeningFilterMode mode = OpeningFilterMode.Default)
```

This handles:
1. UTF-8 encoding the path
2. Pinning the byte array and calling the appropriate FFI function
3. Deserializing the returned JSON buffer using `System.Text.Json` directly from the unmanaged memory (via `ReadOnlySpan<byte>` for small payloads, `UnmanagedMemoryStream` for huge ones)
4. Calling `ifc_lite_free` in a `finally` block to return the buffer to Rust
5. Decoding IFC STEP strings (handling encoded Nordic characters like `\X2\00E6\X0\` → `æ`)

### Memory Management

This is the one thing you have to get right with FFI. The Rust side allocates via `Box::into_raw()` and the C# side *must* call `ifc_lite_free` with the exact pointer and length. We wrap the deserialization in `try/finally` to guarantee cleanup even if JSON parsing fails.

### DLL Placement

The DLL lives next to the plugin assembly. Our `.csproj` copies it from `tools/ifc-lite/` to the output directory at build time:

```xml
<IfcLiteFiles Include="$(ProjectDir)tools\ifc-lite\ifc_lite_ffi.dll"
              Condition="Exists('$(ProjectDir)tools\ifc-lite\ifc_lite_ffi.dll')" />
```

An `IsAvailable` property checks for the DLL's existence (cached after first check) so the UI can gracefully fall back to server mode or show a "DLL not found" message.

---

## Dual-Mode Architecture: FFI vs Server

We support two execution modes for the same parse operation:

| Mode | How it works | When we use it |
|------|-------------|----------------|
| **FFI (local DLL)** | In-process call via P/Invoke. Fastest path, ~930 KB DLL. | Default when DLL is present. Best for typical files. |
| **Server (HTTP)** | POST to `http://127.0.0.1:8080/api/v1/parse` with multipart file upload. | Fallback, or when the server is already running for other tools. |

Both return the same `ParseResponse` JSON schema, so the downstream mesh-to-Rhino code doesn't care which path was used.

The server can be started with the included `run-ifc-server.ps1` script or manually:

```powershell
$env:PORT = "8080"
$env:RUST_LOG = "warn"
.\ifc-lite-server.exe
```

---

## The Response Schema

Both FFI and server return identical JSON. Here's what you get:

```json
{
  "mesh_coordinate_space": "site_local",
  "site_transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1],
  "building_transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1],
  "meshes": [
    {
      "express_id": 1234,
      "ifc_type": "IfcWall",
      "global_id": "2O2Fr$t4X7Zf8NOew3FL9z",
      "name": "Basic Wall:Generic - 200mm",
      "positions": [x,y,z, x,y,z, ...],
      "normals": [nx,ny,nz, ...],
      "indices": [0,1,2, ...],
      "color": [0.85, 0.85, 0.85, 1.0],
      "material_name": "Concrete",
      "presentation_layer": "A-WALL",
      "properties": { "key": "value" }
    }
  ],
  "metadata": {
    "schema_version": "IFC4",
    "entity_count": 12345,
    "geometry_entity_count": 456
  },
  "stats": {
    "total_meshes": 456,
    "total_vertices": 123456,
    "total_triangles": 78901,
    "total_time_ms": 1234
  }
}
```

**Key details:**
- `mesh_coordinate_space: "site_local"` means vertices are in site-local coordinates. Apply `site_transform` and `building_transform` on the block/instance level, not per-vertex.
- Transforms are column-major 4x4 matrices (16 doubles), translation in meters at indices 12, 13, 14.
- Positions are `float32` in meters. Normals are unit vectors.
- Colors are RGBA in 0–1 range. Alpha < 1.0 indicates transparency (e.g., windows default to `[0.6, 0.8, 1.0, 0.4]`).

---

## Opening Filter Modes

This is probably the most useful feature we added. BIM models often have thousands of window/door elements that clutter analysis workflows:

| Mode | Value | Behaviour |
|------|-------|-----------|
| `Default` | 0 | Export everything. Windows/doors get meshes, their voids cut into host walls. |
| `IgnoreAll` | 1 | Skip all `IfcWindow`/`IfcDoor` meshes. Don't cut any voids. Walls come out solid. Also skips profile voids (for Revit models that bake openings into the wall profile). |
| `IgnoreOpaque` | 2 | Keep glazed windows (transparent or named "glas*"), skip opaque ones. Voids for skipped elements are filled back in. |

`IgnoreAll` is particularly useful for energy analysis, daylight simulation, and distance-field computation where you need clean wall surfaces without holes.

The glass detection heuristic checks: element name containing "glas", alpha < 1.0 on the resolved color, or any sub-geometry style with transparency or a material name containing "glas".

---

## Building the DLL

```powershell
cd ifc-lite

# Build FFI DLL
cargo build --release -p ifc-lite-ffi
# Output: target/release/ifc_lite_ffi.dll (~930 KB)

# Build server (optional)
cargo build --release -p ifc-lite-server
# Output: target/release/ifc-lite-server.exe (~7.8 MB)

# Copy to your project's tools folder
Copy-Item .\target\release\ifc_lite_ffi.dll ..\your-project\tools\ifc-lite\ -Force
Copy-Item .\target\release\ifc-lite-server.exe ..\your-project\tools\ifc-lite\ -Force
```

The FFI DLL has no runtime dependencies beyond the Windows CRT. No Rust toolchain needed at deployment time.

---

## Example: Minimal Rhino Command

We've included a standalone example command in `scripts/IFCliteCommand.cs` that demonstrates the server-mode integration. It's a single-file Rhino command that:

1. Checks server health at `http://127.0.0.1:8080/api/v1/health`
2. Opens a file dialog for IFC selection (multi-select supported)
3. POSTs each file to `/api/v1/parse`
4. Converts returned meshes to Rhino `Mesh` objects
5. Creates layers per IFC type with the default colors
6. Adds meshes to the document

The mesh conversion is trivial — positions are already triangulated XYZ triplets:

```csharp
var mesh = new Mesh();
for (int i = 0; i + 2 < src.Positions.Count; i += 3)
    mesh.Vertices.Add(src.Positions[i], src.Positions[i + 1], src.Positions[i + 2]);
for (int i = 0; i + 2 < src.Indices.Count; i += 3)
    mesh.Faces.AddFace((int)src.Indices[i], (int)src.Indices[i + 1], (int)src.Indices[i + 2]);
mesh.Normals.ComputeNormals();
```

---

## Lessons Learned

1. **FFI > HTTP for desktop plugins.** The in-process FFI path eliminates network overhead, firewall prompts, and the need to manage a server process. For a Rhino plugin where users expect instant response, this matters.

2. **Same JSON schema for both paths.** Having the FFI and server return identical JSON meant we could develop against the server (easier to debug with curl/Postman) and switch to FFI for production without touching deserialization code.

3. **Opening filters save downstream work.** Instead of filtering windows/doors after import, doing it at parse time means fewer meshes to transfer, fewer objects to manage, and cleaner wall geometry for analysis. The profile-void skipping was essential for Revit exports.

4. **Site-local coordinates with separate transforms.** Returning meshes in site-local space with the site/building transforms as separate matrices gives the client full control over placement without losing precision to float32 limits on large coordinates.

5. **STEP string decoding matters.** IFC files from Nordic countries encode characters like æ, ø, å as `\X2\00E6\X0\`. If you're showing element names to users, decode them.

---

## Contributing Back

The FFI crate and processing crate are designed to be upstreamed. If you're implementing IFC-Lite in another desktop environment (Unity, Unreal, WPF, Qt, etc.), the same FFI surface works from any language with C interop. PRs welcome.
