/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse (3Dconnexion) controls hook for the 3D viewport.
 *
 * Connects to a 6DOF device over WebHID and drives the camera from a single
 * requestAnimationFrame loop that runs only while a device is connected.
 * Connection is imperative (WebHID requires a user gesture), so the hook
 * registers connect/disconnect callbacks into the store for the toolbar to
 * invoke and mirrors the live connection flag back for the UI.
 *
 * Mirrors the structure of `useMouseControls` / `useKeyboardControls`: a
 * single effect keyed on `isInitialized`, refs for anything read inside the
 * loop, full teardown on unmount.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { SpaceMouseDriver } from '@/lib/spacemouse/SpaceMouseDriver.js';
import { motionToCameraDeltas, motionToFirstPersonDeltas } from '@/lib/spacemouse/cameraMapping.js';

export interface UseSpaceMouseControlsParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  /** Walk mode → translate as first-person movement instead of orbit/pan. */
  firstPersonModeRef: MutableRefObject<boolean>;
  /** Marks the frame as an interaction so the renderer can drop to fast quality. */
  isInteractingRef: MutableRefObject<boolean>;
  /** User sensitivity multiplier (1 = default). */
  sensitivityRef: MutableRefObject<number>;
  updateCameraRotationRealtime: (rotation: { azimuth: number; elevation: number }) => void;
  calculateScale: () => void;
  /** Registers imperative connect/disconnect handlers for the toolbar. */
  setSpaceMouseCallbacks: (callbacks: {
    connect?: () => Promise<boolean>;
    disconnect?: () => void;
  }) => void;
  /** Mirrors the live connection state into the store for the UI. */
  setSpaceMouseConnected: (connected: boolean) => void;
}

export function useSpaceMouseControls(params: UseSpaceMouseControlsParams): void {
  const {
    rendererRef,
    isInitialized,
    firstPersonModeRef,
    isInteractingRef,
    sensitivityRef,
    updateCameraRotationRealtime,
    calculateScale,
    setSpaceMouseCallbacks,
    setSpaceMouseConnected,
  } = params;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    if (!SpaceMouseDriver.isSupported()) {
      // No WebHID (Firefox/Safari): leave callbacks unset so the toolbar
      // hides the affordance entirely.
      return;
    }

    const camera = renderer.getCamera();
    const driver = new SpaceMouseDriver();

    let rafId: number | null = null;
    let lastFrameTime = 0;
    let running = false;

    const tick = (now: number) => {
      if (!running) return;
      const dt = lastFrameTime === 0 ? 1000 / 60 : now - lastFrameTime;
      lastFrameTime = now;

      const motion = driver.getMotion();
      const sensitivity = sensitivityRef.current;
      let active: boolean;

      if (firstPersonModeRef.current) {
        // Walk mode: translation becomes first-person movement, twist/tilt steer.
        const fp = motionToFirstPersonDeltas(motion, dt, sensitivity);
        active = fp.active;
        if (fp.active) {
          if (fp.forward !== 0 || fp.strafe !== 0 || fp.up !== 0) {
            camera.moveFirstPerson(fp.forward, fp.strafe, fp.up);
          }
          if (fp.turnX !== 0 || fp.turnY !== 0) {
            camera.orbit(fp.turnX, fp.turnY, false);
          }
        }
      } else {
        const deltas = motionToCameraDeltas(motion, dt, sensitivity);
        active = deltas.active;
        if (deltas.active) {
          if (deltas.orbitX !== 0 || deltas.orbitY !== 0) {
            camera.orbit(deltas.orbitX, deltas.orbitY, false);
          }
          if (deltas.panX !== 0 || deltas.panY !== 0) {
            camera.pan(deltas.panX, deltas.panY, false);
          }
          if (deltas.zoom !== 0) {
            camera.zoom(deltas.zoom, false);
          }
        }
      }

      if (active) {
        isInteractingRef.current = true;
        renderer.requestRender();
        updateCameraRotationRealtime(camera.getRotation());
        calculateScale();
        rafId = requestAnimationFrame(tick);
      } else {
        // Cap returned to centre — drop the interaction flag once so the
        // renderer can settle back to full quality, then idle the loop until
        // the next device report wakes it (see driver.onMotion below).
        if (isInteractingRef.current) {
          isInteractingRef.current = false;
          renderer.requestRender();
        }
        running = false;
        rafId = null;
      }
    };

    const startLoop = () => {
      if (running || !driver.isConnected()) return;
      running = true;
      lastFrameTime = 0;
      rafId = requestAnimationFrame(tick);
    };

    // Wake the (idle) render loop whenever the device reports motion, so a
    // connected-but-untouched SpaceMouse costs no per-frame work.
    driver.onMotion(startLoop);

    const stopLoop = () => {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    driver.onDisconnect(() => {
      stopLoop();
      setSpaceMouseConnected(false);
    });

    setSpaceMouseCallbacks({
      connect: async () => {
        const ok = await driver.connect();
        if (ok) {
          // The loop is woken by device reports (driver.onMotion); no need to
          // spin it up here — it stays idle until the cap is first moved.
          setSpaceMouseConnected(true);
        }
        return ok;
      },
      disconnect: () => {
        stopLoop();
        void driver.disconnect();
        setSpaceMouseConnected(false);
      },
    });

    return () => {
      stopLoop();
      void driver.disconnect();
      setSpaceMouseCallbacks({});
      setSpaceMouseConnected(false);
    };
  }, [isInitialized]);
}

export default useSpaceMouseControls;
