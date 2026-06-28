/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure parsing of 3Dconnexion SpaceMouse HID input reports.
 *
 * 3Dconnexion devices expose six degrees of freedom as signed 16-bit
 * little-endian counts. Two report layouts exist in the wild:
 *
 *  - Split: report 1 carries translation (Tx,Ty,Tz), report 2 carries
 *    rotation (Rx,Ry,Rz). Older wired SpaceNavigator / SpacePilot.
 *  - Combined: report 1 carries all six axes back-to-back (12 bytes).
 *    Newer wireless / universal-receiver devices.
 *
 * The reportId byte itself is NOT part of the `DataView` handed to us by
 * WebHID (it lives on `event.reportId`), so axis offsets start at 0. Report
 * 3 (buttons) and feature reports are ignored — the viewer maps motion only.
 *
 * Raw counts saturate around ±350 at full cap deflection; callers
 * normalise against {@link AXIS_FULL_SCALE}.
 */

/** Raw count at (roughly) full cap deflection — used to normalise to [-1, 1]. */
export const AXIS_FULL_SCALE = 350;

export const REPORT_TRANSLATION = 1;
export const REPORT_ROTATION = 2;

/** Six-axis displacement, each component normalised to roughly [-1, 1]. */
export interface SpaceMouseMotion {
  /** Translation: +x cap pulled right. */
  tx: number;
  /** Translation: +y cap pulled up (lifted). */
  ty: number;
  /** Translation: +z cap pushed away from the user. */
  tz: number;
  /** Rotation: pitch — cap tilted forward/back. */
  rx: number;
  /** Rotation: roll — cap tilted left/right. */
  ry: number;
  /** Rotation: yaw — cap twisted. */
  rz: number;
}

export const ZERO_MOTION: Readonly<SpaceMouseMotion> = Object.freeze({
  tx: 0,
  ty: 0,
  tz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
});

export interface ParsedReport {
  /** Axis components present in this report, normalised to ~[-1, 1]. */
  motion?: Partial<SpaceMouseMotion>;
}

function axis(data: DataView, byteOffset: number): number {
  // Saturating normalise; clamp so a slightly-over-range device can't
  // push deltas past the calibrated maximum.
  const raw = data.getInt16(byteOffset, /* littleEndian */ true);
  const n = raw / AXIS_FULL_SCALE;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

/**
 * Decode one SpaceMouse HID input report. Returns the axes the report
 * carried; unknown report ids (buttons, feature reports) or short buffers
 * yield an empty result rather than throwing — the viewer maps motion only.
 */
export function parseSpaceMouseReport(reportId: number, data: DataView): ParsedReport {
  switch (reportId) {
    case REPORT_TRANSLATION: {
      if (data.byteLength >= 12) {
        // Combined layout: all six axes in one report.
        return {
          motion: {
            tx: axis(data, 0),
            ty: axis(data, 2),
            tz: axis(data, 4),
            rx: axis(data, 6),
            ry: axis(data, 8),
            rz: axis(data, 10),
          },
        };
      }
      if (data.byteLength >= 6) {
        return { motion: { tx: axis(data, 0), ty: axis(data, 2), tz: axis(data, 4) } };
      }
      return {};
    }
    case REPORT_ROTATION: {
      if (data.byteLength >= 6) {
        return { motion: { rx: axis(data, 0), ry: axis(data, 2), rz: axis(data, 4) } };
      }
      return {};
    }
    default:
      return {};
  }
}
