// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raw national-grid coordinates (UTM, ~6.7 million northing) and the f32 precision they cost.
//!
//! A float32 at 6.7 million has a 0.5 m step, so any path that stores such a coordinate as f32
//! quantises it for good. Two things here keep the millimetres: the RTC vote for a far placement
//! looks at where the element REALLY is, and raw surface-model points are anchored in f64.

use super::GeometryRouter;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    pub(super) fn representation_item_uses_raw_large_coordinates(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        self.raw_first_vertex(item, decoder)
            .map(|point| self.raw_coordinate_is_large(point))
            .unwrap_or(false)
    }

    /// First raw vertex of a representation item, in FILE units, for the item types whose
    /// processors store raw (un-placed) coordinates. `None` for everything else.
    pub(super) fn raw_first_vertex(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        match item.ifc_type {
            IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
                self.brep_first_vertex(item, decoder)
            }
            IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork
            | IfcType::IfcPolygonalFaceSet => self.tessellated_first_vertex(item, decoder),
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                let Some(shells_attr) = item.get(0) else {
                    return None;
                };
                let Some(shells) = shells_attr.as_list() else {
                    return None;
                };
                let Some(shell_ref) = shells.first() else {
                    return None;
                };
                let Some(shell_id) = shell_ref.as_entity_ref() else {
                    return None;
                };
                match decoder.decode_by_id(shell_id) {
                    Ok(shell) => self.shell_first_vertex(&shell, decoder),
                    Err(_) => None,
                }
            }
            _ => None,
        }
    }

    /// The world position of an element whose PLACEMENT is far from the origin, read from its
    /// first vertex. A far placement is not proof of a far element: files that carry absolute
    /// points (UTM) and cancel them with a negative context/placement translation have a huge
    /// placement AND huge vertices that sum to a small world position. Trusting the placement
    /// alone picked it as the RTC anchor, so the subtraction ADDED the offset back and the mesh
    /// left at ~6.7 million, where f32 steps are 0.5 m. `None` for a near placement or when the
    /// vertex cannot be read (swept solids), so the caller falls back to the placement as before.
    pub(super) fn far_placement_world(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        transform: &Matrix4<f64>,
    ) -> Option<(f64, f64, f64)> {
        const NEAR_ORIGIN: f64 = 1000.0;
        let (tx, ty, tz) = (transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        if tx.abs() < NEAR_ORIGIN && ty.abs() < NEAR_ORIGIN && tz.abs() < NEAR_ORIGIN {
            return None;
        }
        let (vx, vy, vz) = self.sample_first_geometry_vertex(entity, decoder)?;
        let world = transform.transform_point(&nalgebra::Point3::new(
            vx * self.unit_scale,
            vy * self.unit_scale,
            vz * self.unit_scale,
        ));
        (world.x.is_finite() && world.y.is_finite() && world.z.is_finite())
            .then_some((world.x, world.y, world.z))
    }

    /// Meshes a raw national-grid surface model with a whole-unit anchor subtracted in f64
    /// BEFORE the f32 cast, carrying the anchor in `mesh.origin` (PRE-transform translation,
    /// metres) for the world transform to add back in f64. Any other item is meshed as usual.
    /// The mesh is returned in file units (the caller scales positions), with `origin` already
    /// in metres. Not content-cached: the hash cannot tell two anchors apart.
    pub(super) fn process_item_mesh(
        &self,
        processor: &std::sync::Arc<dyn super::GeometryProcessor>,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        if matches!(
            item.ifc_type,
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel
        ) {
            if let Some(first) = self.raw_first_vertex(item, decoder) {
                if self.raw_coordinate_is_large(first) {
                    let anchor = (first.0.round(), first.1.round(), first.2.round());
                    let mut mesh = crate::processors::with_raw_anchor(anchor, || {
                        processor.process(item, decoder, &self.schema, self.tessellation_quality)
                    })?;
                    if !mesh.positions.is_empty() {
                        mesh.origin = [
                            anchor.0 * self.unit_scale,
                            anchor.1 * self.unit_scale,
                            anchor.2 * self.unit_scale,
                        ];
                    }
                    return Ok(mesh);
                }
            }
        }
        processor.process(item, decoder, &self.schema, self.tessellation_quality)
    }
}
