/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebHID driver for 3Dconnexion SpaceMouse (and compatible 6DOF) devices.
 *
 * Owns the device connection and folds the split/combined HID reports into
 * a single latest-motion snapshot. The render loop reads {@link getMotion}
 * once per frame — the driver never drives the camera itself, keeping it
 * framework-agnostic and unit-testable (parsing lives in `parseReport.ts`).
 *
 * Devices stream reports continuously while the cap is displaced and emit a
 * final zero report on release, so a latest-state snapshot needs no
 * debouncing or timeout.
 */

import {
  ZERO_MOTION,
  parseSpaceMouseReport,
  type SpaceMouseMotion,
} from './parseReport.js';

/**
 * Known 3Dconnexion USB vendor ids. Older devices enumerate under
 * Logitech's id (3Dconnexion was a Logitech subsidiary); current ones use
 * the dedicated 3Dconnexion id.
 */
const VENDOR_IDS = [
  0x046d, // Logitech (legacy 3Dconnexion)
  0x256f, // 3Dconnexion
];

export class SpaceMouseDriver {
  private device: HIDDevice | null = null;
  private motion: SpaceMouseMotion = { ...ZERO_MOTION };
  private onDisconnectCb: (() => void) | null = null;
  private onMotionCb: (() => void) | null = null;

  /** True when the host browser exposes WebHID at all (Chromium-based). */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.hid;
  }

  isConnected(): boolean {
    return this.device !== null && this.device.opened;
  }

  /** Latest six-axis snapshot. Mutated in place each report — copy if retained. */
  getMotion(): Readonly<SpaceMouseMotion> {
    return this.motion;
  }

  /** Invoked when the device is unplugged or otherwise vanishes. */
  onDisconnect(cb: (() => void) | null): void {
    this.onDisconnectCb = cb;
  }

  /**
   * Invoked after every motion report (including the zero report on
   * release). Lets the consumer wake an idle render loop on demand rather
   * than polling forever while the device sits untouched.
   */
  onMotion(cb: (() => void) | null): void {
    this.onMotionCb = cb;
  }

  /**
   * Connect to a SpaceMouse. Reuses an already-granted device when present,
   * otherwise prompts the user to pick one (must be called from a user
   * gesture per the WebHID permission model). Returns false when WebHID is
   * unavailable or no device was selected.
   */
  async connect(): Promise<boolean> {
    if (!SpaceMouseDriver.isSupported()) return false;
    const hid = navigator.hid!;

    const filters = VENDOR_IDS.map((vendorId) => ({ vendorId }));

    let device =
      (await hid.getDevices()).find((d) => VENDOR_IDS.includes(d.vendorId)) ?? null;

    if (!device) {
      const picked = await hid.requestDevice({ filters });
      device = picked.find((d) => VENDOR_IDS.includes(d.vendorId)) ?? picked[0] ?? null;
    }

    if (!device) return false;

    if (!device.opened) {
      await device.open();
    }

    device.addEventListener('inputreport', this.handleInputReport);
    hid.addEventListener('disconnect', this.handleHidDisconnect);
    this.device = device;
    return true;
  }

  /** Detach listeners, close the device, and zero the motion snapshot. */
  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.motion = { ...ZERO_MOTION };
    if (navigator.hid) {
      navigator.hid.removeEventListener('disconnect', this.handleHidDisconnect);
    }
    if (!device) return;
    device.removeEventListener('inputreport', this.handleInputReport);
    try {
      if (device.opened) await device.close();
    } catch (err) {
      // Closing can reject if the device already went away; surface it for
      // diagnostics rather than swallowing silently (house rule), but don't
      // propagate — a failed close shouldn't break teardown.
      console.warn('[spacemouse] failed to close device', err);
    }
  }

  private handleInputReport = (event: HIDInputReportEvent): void => {
    const { motion } = parseSpaceMouseReport(event.reportId, event.data);
    if (motion) {
      Object.assign(this.motion, motion);
      this.onMotionCb?.();
    }
  };

  private handleHidDisconnect = (event: HIDConnectionEvent): void => {
    if (event.device !== this.device) return;
    this.device = null;
    this.motion = { ...ZERO_MOTION };
    this.onDisconnectCb?.();
  };
}
