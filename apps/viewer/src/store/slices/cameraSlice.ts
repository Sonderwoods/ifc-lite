/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera state slice
 */

import type { StateCreator } from 'zustand';
import type { CameraRotation, CameraCallbacks, ProjectionMode, SpaceMouseCallbacks } from '../types.js';
import { CAMERA_DEFAULTS } from '../constants.js';

export interface CameraSlice {
  // State
  cameraRotation: CameraRotation;
  cameraCallbacks: CameraCallbacks;
  projectionMode: ProjectionMode;
  onCameraRotationChange: ((rotation: CameraRotation) => void) | null;
  onScaleChange: ((scale: number) => void) | null;
  /** Imperative connect/disconnect handlers for a SpaceMouse (WebHID). */
  spaceMouseCallbacks: SpaceMouseCallbacks;
  /** True while a SpaceMouse is connected and streaming. */
  spaceMouseConnected: boolean;
  /** User sensitivity multiplier for SpaceMouse navigation (1 = default). */
  spaceMouseSensitivity: number;

  // Actions
  setCameraRotation: (rotation: CameraRotation) => void;
  setCameraCallbacks: (callbacks: CameraCallbacks) => void;
  setProjectionMode: (mode: ProjectionMode) => void;
  toggleProjectionMode: () => void;
  setOnCameraRotationChange: (callback: ((rotation: CameraRotation) => void) | null) => void;
  updateCameraRotationRealtime: (rotation: CameraRotation) => void;
  setOnScaleChange: (callback: ((scale: number) => void) | null) => void;
  updateScaleRealtime: (scale: number) => void;
  setSpaceMouseCallbacks: (callbacks: SpaceMouseCallbacks) => void;
  setSpaceMouseConnected: (connected: boolean) => void;
  setSpaceMouseSensitivity: (sensitivity: number) => void;
}

export const createCameraSlice: StateCreator<CameraSlice, [], [], CameraSlice> = (set, get) => ({
  // Initial state
  cameraRotation: {
    azimuth: CAMERA_DEFAULTS.AZIMUTH,
    elevation: CAMERA_DEFAULTS.ELEVATION,
  },
  cameraCallbacks: {},
  projectionMode: 'perspective',
  onCameraRotationChange: null,
  onScaleChange: null,
  spaceMouseCallbacks: {},
  spaceMouseConnected: false,
  spaceMouseSensitivity: 1,

  // Actions
  setCameraRotation: (cameraRotation) => set({ cameraRotation }),
  setCameraCallbacks: (cameraCallbacks) => set({ cameraCallbacks }),
  setProjectionMode: (projectionMode) => {
    get().cameraCallbacks.setProjectionMode?.(projectionMode);
    set({ projectionMode });
  },
  toggleProjectionMode: () => {
    const newMode = get().projectionMode === 'perspective' ? 'orthographic' : 'perspective';
    get().cameraCallbacks.setProjectionMode?.(newMode);
    set({ projectionMode: newMode });
  },
  setOnCameraRotationChange: (onCameraRotationChange) => set({ onCameraRotationChange }),

  updateCameraRotationRealtime: (rotation) => {
    const callback = get().onCameraRotationChange;
    if (callback) {
      // Use direct callback - no React state update, no re-renders
      callback(rotation);
    }
    // Don't update store state during real-time updates
  },

  setOnScaleChange: (onScaleChange) => set({ onScaleChange }),

  updateScaleRealtime: (scale) => {
    const callback = get().onScaleChange;
    if (callback) {
      // Use direct callback - no React state update, no re-renders
      callback(scale);
    }
    // Don't update store state during real-time updates
  },

  setSpaceMouseCallbacks: (spaceMouseCallbacks) => set({ spaceMouseCallbacks }),
  setSpaceMouseConnected: (spaceMouseConnected) => set({ spaceMouseConnected }),
  setSpaceMouseSensitivity: (spaceMouseSensitivity) =>
    set({ spaceMouseSensitivity: Math.max(0.1, Math.min(4, spaceMouseSensitivity)) }),
});
