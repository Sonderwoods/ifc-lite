# IFC Wall Void Cutting — Stray Triangle Fixes (2026-03-18)

Two bugs in the ifc-lite Rust geometry engine caused corrupted wall meshes when
cutting IfcOpeningElement voids. Walls looked fine without voids; the corruption
was purely in the void subtraction pipeline.

---

## Bug 1: Flipped-plane epsilon duplication in AABB clipping

**File:** `geometry/src/router/voids.rs` — `clip_triangle_against_box`

### What happened

The AABB clipping algorithm clips each wall triangle against the 6 inward-facing
planes of the opening box. For each plane it needs to separate the triangle into:

- **Front (inside box boundary)** — continues to the next plane
- **Behind (outside box boundary)** — emitted to the result immediately

The old code computed the "behind" parts by re-clipping the *original* triangle
against a **flipped plane** (same point, negated normal). This worked most of the
time, but broke when triangle vertices sat within epsilon (1e-6 m) of the
clipping plane.

`clip_triangle` uses `distance >= -epsilon` to classify a vertex as "front".
When a vertex is at distance +0.5e-7 from the original plane:

| Plane    | Distance  | Classified as |
|----------|-----------|---------------|
| Original | +0.5e-7   | front (>= -1e-6) |
| Flipped  | -0.5e-7   | **also front** (>= -1e-6) |

So the original clip returned `Split(front_tris)` while the flipped clip returned
`AllFront` — meaning the **entire original triangle** was added to the result as
an "outside" piece, even though only a sliver was actually behind the plane.

### Symptom

- Stray triangles spanning the full 16 m wall face
- Triangle count explosion: 12 base triangles → 662 after void cutting
- Progressively worse from left to right as errors accumulated across 20 sequential clips (10 openings × 2 sub-items each)

### Fix

Compute back (outside) parts **directly from the split geometry** using the same
intersection points. No second clip needed, no epsilon inconsistency possible:

- **1-front split:** back = quad (p1, back1, back2, p2) → 2 triangles
- **2-front split:** back = triangle (p1, p2, back) → 1 triangle

Both sides share the exact same interpolated intersection points `p1` and `p2`,
so there are no gaps or overlaps at the cut boundary.

### Affected walls

Any wall with rectangular openings processed via AABB clipping (the majority).
Most visible on long walls (large face triangles) with many openings (more
sequential clips = more chances for near-plane vertices).

---

## Bug 2: Tiny CSG openings destroying wall meshes

**File:** `geometry/src/router/voids.rs` — `process_element_with_voids` (NonRectangular path)

### What happened

Some IfcOpeningElements have a vertical extrusion direction (0, 0, 1) even in
walls — for example, 17 mm × 14 mm × 10 mm connection points. The code's
`is_floor_opening` heuristic checks if *any* opening item has `|dir.z| > 0.95`
and if so, forces the entire opening into the **NonRectangular (CSG)** path.

The `csgrs` BSP tree then had to subtract a tiny 8-triangle mesh from a
400-triangle wall mesh. The BSP merge produced a degenerate result with only
~19 triangles — destroying 95 % of the wall geometry.

The old validation only checked `triangle_count >= 4`, which passed despite
the catastrophic loss.

### Symptom

- Diagonal wall appears to have almost no openings cut
- Triangle count drops from 400 (after correct diagonal batch) to 19 (after CSG)
- Wall looks like a nearly-solid slab with tiny fragments

### Fix

Three guards before CSG subtraction:

1. **Bounds overlap check** — skip if opening AABB doesn't intersect wall AABB
2. **Volume threshold** — skip openings with volume < 0.001 m3 (< 1 litre),
   which catches modelling artefacts and connection points
3. **Result validation** — reject CSG output that loses more than 75 % of the
   pre-CSG triangle count, keeping the previous mesh instead

### Affected walls

Diagonal walls with small IfcOpeningElements that have vertical extrusion
direction. The `is_floor_opening` misclassification only affects walls (floors
with vertical openings are handled correctly by design).

---

## Test wall GUIDs

| GUID | Issue | Opening count | Wall type |
|------|-------|---------------|-----------|
| `1Rad0MmHP4rRAOyQ3nuHaF` | Bug 1 (flipped-plane) | 10 | Axis-aligned, 16 m long |
| `0leoysMXLEdQR5Bq_peXAf` | Bug 2 (tiny CSG) | 7 | Diagonal, ~7.8 m long |

Both walls are in `ifc/TUN32-BT2-ARK - forenklet.ifc`.

## Cache

The ifc-lite server caches parsed results on disk (`.cache/` directory, content-addressed by file SHA256). After rebuilding the server or FFI DLL, delete the cache directory and restart — otherwise the old (corrupted) geometry is served from cache.
