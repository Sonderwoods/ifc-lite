/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ZERO_MOTION, type SpaceMouseMotion } from './parseReport';
import { DEADZONE, motionToCameraDeltas } from './cameraMapping';

const FRAME = 1000 / 60;

function motion(partial: Partial<SpaceMouseMotion>): SpaceMouseMotion {
  return { ...ZERO_MOTION, ...partial };
}

describe('motionToCameraDeltas', () => {
  it('is inert at rest', () => {
    const d = motionToCameraDeltas(motion({}), FRAME);
    assert.strictEqual(d.active, false);
    // `=== 0` rather than strictEqual so a signed-zero (-0) still passes.
    assert.ok(d.orbitX === 0 && d.panX === 0 && d.zoom === 0);
  });

  it('suppresses jitter within the deadzone', () => {
    const d = motionToCameraDeltas(motion({ tx: DEADZONE * 0.9, rx: DEADZONE * 0.9 }), FRAME);
    assert.strictEqual(d.active, false);
  });

  it('pushing the cap away (+Tz) zooms in (negative zoom delta)', () => {
    const d = motionToCameraDeltas(motion({ tz: 1 }), FRAME);
    assert.ok(d.zoom < 0, `expected zoom-in, got ${d.zoom}`);
  });

  it('cap right (+Tx) pans the view right (negative pan deltaX)', () => {
    const d = motionToCameraDeltas(motion({ tx: 1 }), FRAME);
    assert.ok(d.panX < 0, `expected negative panX, got ${d.panX}`);
  });

  it('twist (Rz) drives azimuth, tilt (Rx) drives elevation', () => {
    const d = motionToCameraDeltas(motion({ rz: 1, rx: 0.5 }), FRAME);
    assert.ok(d.orbitX !== 0 && d.orbitY !== 0);
    assert.ok(Math.abs(d.orbitX) > Math.abs(d.orbitY));
  });

  it('scales with sensitivity', () => {
    const base = motionToCameraDeltas(motion({ tz: 1 }), FRAME, 1);
    const fast = motionToCameraDeltas(motion({ tz: 1 }), FRAME, 2);
    assert.ok(Math.abs(fast.zoom) > Math.abs(base.zoom) * 1.9);
  });

  it('is frame-rate independent (double dt ≈ double delta)', () => {
    const one = motionToCameraDeltas(motion({ tz: 1 }), FRAME);
    const two = motionToCameraDeltas(motion({ tz: 1 }), FRAME * 2);
    assert.ok(Math.abs(two.zoom - one.zoom * 2) < 1e-9);
  });

  it('clamps a long stall so a backgrounded tab cannot lurch', () => {
    const huge = motionToCameraDeltas(motion({ tz: 1 }), FRAME * 100);
    const fourFrames = motionToCameraDeltas(motion({ tz: 1 }), FRAME * 4);
    assert.ok(Math.abs(huge.zoom) <= Math.abs(fourFrames.zoom) + 1e-9);
  });
});
