/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  AXIS_FULL_SCALE,
  REPORT_ROTATION,
  REPORT_TRANSLATION,
  parseSpaceMouseReport,
} from './parseReport';

/** Build a DataView holding little-endian int16 axis counts. */
function reportOf(...counts: number[]): DataView {
  const buf = new ArrayBuffer(counts.length * 2);
  const view = new DataView(buf);
  counts.forEach((c, i) => view.setInt16(i * 2, c, /* littleEndian */ true));
  return view;
}

describe('parseSpaceMouseReport', () => {
  it('decodes the split translation report (3 axes)', () => {
    const r = parseSpaceMouseReport(REPORT_TRANSLATION, reportOf(AXIS_FULL_SCALE, 0, -AXIS_FULL_SCALE));
    assert.deepStrictEqual(r.motion, { tx: 1, ty: 0, tz: -1 });
  });

  it('decodes the split rotation report (3 axes)', () => {
    const r = parseSpaceMouseReport(REPORT_ROTATION, reportOf(0, AXIS_FULL_SCALE, 0));
    assert.deepStrictEqual(r.motion, { rx: 0, ry: 1, rz: 0 });
  });

  it('decodes the combined 6-axis report from report id 1', () => {
    const r = parseSpaceMouseReport(
      REPORT_TRANSLATION,
      reportOf(AXIS_FULL_SCALE, 0, 0, 0, 0, AXIS_FULL_SCALE),
    );
    assert.deepStrictEqual(r.motion, { tx: 1, ty: 0, tz: 0, rx: 0, ry: 0, rz: 1 });
  });

  it('saturates counts beyond full scale to the unit range', () => {
    const r = parseSpaceMouseReport(REPORT_TRANSLATION, reportOf(AXIS_FULL_SCALE * 4, 0, 0));
    assert.strictEqual(r.motion?.tx, 1);
  });

  it('reads the little-endian sign correctly', () => {
    // -1 count = 0xFFFF little-endian; a naive big-endian read would mis-sign.
    const r = parseSpaceMouseReport(REPORT_TRANSLATION, reportOf(-1, 0, 0));
    assert.ok((r.motion?.tx ?? 0) < 0);
  });

  it('ignores unknown report ids and short buffers', () => {
    assert.deepStrictEqual(parseSpaceMouseReport(99, reportOf(1, 2, 3)), {});
    assert.deepStrictEqual(parseSpaceMouseReport(REPORT_TRANSLATION, reportOf(1)), {});
  });
});
