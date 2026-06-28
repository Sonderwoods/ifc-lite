/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal ambient declarations for the WebHID API.
 *
 * TypeScript's bundled DOM lib does not yet ship WebHID types and the
 * project pins `lib: ["DOM"]`, so the SpaceMouse driver would otherwise
 * need `as any` casts (banned by the house rules). Only the slice of the
 * spec the driver touches is declared here — extend as needed rather than
 * pulling in `@types/w3c-web-hid` for one consumer.
 */

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDeviceEventMap {
  inputreport: HIDInputReportEvent;
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

interface HIDEventMap {
  connect: HIDConnectionEvent;
  disconnect: HIDConnectionEvent;
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  addEventListener<K extends keyof HIDEventMap>(
    type: K,
    listener: (this: HID, ev: HIDEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HIDEventMap>(
    type: K,
    listener: (this: HID, ev: HIDEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Navigator {
  readonly hid?: HID;
}
