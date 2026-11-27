/**
 * The tests' composition root: a FakeEngine (also the Developer engine and the demo controls)
 * under a FakeCore, as main.tsx builds them for the app, with the host's data in memory.
 */
import { DeviceStore } from "../core/device.ts";
import { FakeCore } from "../core/fake/FakeCore.ts";
import { MemoryHostStore, type HostStore } from "../core/host.ts";
import { pickDevice } from "../core/device.ts";
import { FakeEngine, type FakeEngineOptions } from "../engine/fake/FakeEngine.ts";
import type { Settings } from "../state/model.ts";

export interface FakeServicesOptions extends FakeEngineOptions {
  /** Seeds the fake host's settings, and this window's device settings (not stored). */
  settings?: Partial<Settings>;
  /** Share these to relaunch onto the same host and device. */
  host?: HostStore;
  device?: DeviceStore;
}

const live = new Set<FakeCore>();

export function fakeServices({ settings, host = new MemoryHostStore(), device, ...engineOptions }: FakeServicesOptions = {}) {
  const engine = new FakeEngine({ stepMs: 50, ...engineOptions });
  const deviceStore = device ?? new DeviceStore(globalThis.localStorage, pickDevice(settings ?? {}));
  const core = new FakeCore({ engine, device: deviceStore, host, settings });
  live.add(core);
  return { engine, developer: engine, demo: engine, core, host, device: deviceStore };
}

/** Stops every core the last test made, so none keeps following its engine. */
export function disposeFakeServices(): void {
  for (const core of live) core.dispose();
  live.clear();
}
