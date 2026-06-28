/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Maps a SpaceMouse six-axis snapshot onto the viewer camera's
 * orbit/pan/zoom deltas. Kept pure so the axis→camera convention is pinned
 * by tests; the hook just feeds the result into `camera.orbit/pan/zoom`.
 *
 * Object-inspection convention (matches 3Dconnexion's default "object"
 * mode in CAD viewers):
 *   - Tx  → pan horizontally   (cap right  → view pans right)
 *   - Ty  → pan vertically     (cap up     → view pans up)
 *   - Tz  → dolly / zoom       (cap pushed away → zoom in)
 *   - Rx  → orbit elevation    (cap tilted     → look up/down)
 *   - Rz  → orbit azimuth      (cap twisted    → spin around model)
 *   - Ry  → roll, intentionally ignored (the camera keeps a fixed up axis)
 */

import type { SpaceMouseMotion } from './parseReport.js';

/** Per-axis base gains, tuned against the camera-controls sensitivities. */
const ORBIT_GAIN = 2.5; // → pixel-equivalent units consumed by camera.orbit
const PAN_GAIN = 9; // → pixel-equivalent units consumed by camera.pan
const ZOOM_GAIN = 70; // → raw delta consumed by camera.zoom (negative = in)

/**
 * Below this normalised magnitude an axis is treated as zero. SpaceMice
 * rest slightly off-centre and never re-zero perfectly, so without a
 * deadzone the view drifts when the user lets go.
 */
export const DEADZONE = 0.06;

/** Reference frame duration (~60fps) the gains are calibrated against. */
const REFERENCE_FRAME_MS = 1000 / 60;

export interface CameraDeltas {
  orbitX: number;
  orbitY: number;
  panX: number;
  panY: number;
  zoom: number;
  /** True when any axis cleared the deadzone — caller can skip a render otherwise. */
  active: boolean;
}

function deadzone(value: number): number {
  if (value > DEADZONE) return (value - DEADZONE) / (1 - DEADZONE);
  if (value < -DEADZONE) return (value + DEADZONE) / (1 - DEADZONE);
  return 0;
}

/**
 * Convert a motion snapshot into camera deltas for one frame.
 *
 * @param motion       normalised six-axis snapshot (~[-1, 1] per axis)
 * @param deltaTimeMs  elapsed time since the previous frame, for
 *                     frame-rate-independent speed
 * @param sensitivity  user multiplier (1 = default)
 */
export function motionToCameraDeltas(
  motion: SpaceMouseMotion,
  deltaTimeMs: number,
  sensitivity = 1,
): CameraDeltas {
  // Clamp dt so a long stall (tab backgrounded) can't produce a giant jump.
  const frames = Math.min(deltaTimeMs, 4 * REFERENCE_FRAME_MS) / REFERENCE_FRAME_MS;
  const k = sensitivity * frames;

  const tx = deadzone(motion.tx);
  const ty = deadzone(motion.ty);
  const tz = deadzone(motion.tz);
  const rx = deadzone(motion.rx);
  const rz = deadzone(motion.rz);

  // camera.pan(deltaX, deltaY): +deltaX moves the scene left, so negate Tx to
  // make "cap right" pan the view right. +deltaY moves the scene down, so a
  // cap-up (+Ty) needs a positive deltaY to pan the view up.
  const panX = -tx * PAN_GAIN * k;
  const panY = ty * PAN_GAIN * k;

  // camera.zoom: positive delta zooms out. Pushing the cap away (+Tz) should
  // zoom in, hence the negation.
  const zoom = -tz * ZOOM_GAIN * k;

  // camera.orbit(deltaX, deltaY): deltaX → azimuth (twist), deltaY → elevation
  // (tilt). Sign chosen so tilting the cap forward looks down, matching a
  // mouse drag downward.
  const orbitX = rz * ORBIT_GAIN * k;
  const orbitY = rx * ORBIT_GAIN * k;

  const active =
    panX !== 0 || panY !== 0 || zoom !== 0 || orbitX !== 0 || orbitY !== 0;

  return { orbitX, orbitY, panX, panY, zoom, active };
}

/** First-person (walk-mode) movement, in `camera.moveFirstPerson` speed units. */
export interface FirstPersonDeltas {
  forward: number;
  strafe: number;
  up: number;
  /** Look azimuth, consumed by `camera.orbit(deltaX, …)`. */
  turnX: number;
  /** Look elevation, consumed by `camera.orbit(…, deltaY)`. */
  turnY: number;
  active: boolean;
}

/** Walk speed at full cap deflection, in `moveFirstPerson` units per frame. */
const WALK_GAIN = 1;

/**
 * Walk-mode variant: translation drives first-person movement (push away →
 * walk forward, lift → rise, slide → strafe) while twist/tilt steer the look
 * direction. Used when the viewer's walk tool is active.
 */
export function motionToFirstPersonDeltas(
  motion: SpaceMouseMotion,
  deltaTimeMs: number,
  sensitivity = 1,
): FirstPersonDeltas {
  const frames = Math.min(deltaTimeMs, 4 * REFERENCE_FRAME_MS) / REFERENCE_FRAME_MS;
  const k = sensitivity * frames;

  const forward = deadzone(motion.tz) * WALK_GAIN * k;
  const strafe = deadzone(motion.tx) * WALK_GAIN * k;
  const up = deadzone(motion.ty) * WALK_GAIN * k;
  const turnX = deadzone(motion.rz) * ORBIT_GAIN * k;
  const turnY = deadzone(motion.rx) * ORBIT_GAIN * k;

  const active =
    forward !== 0 || strafe !== 0 || up !== 0 || turnX !== 0 || turnY !== 0;

  return { forward, strafe, up, turnX, turnY, active };
}
