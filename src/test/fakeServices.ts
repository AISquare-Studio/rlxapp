/**
 * The tests' composition root: a FakeEngine (also the Developer engine and the demo controls)
 * under a FakeCore, as main.tsx builds them for the app.
 */
import { FakeCore } from "../core/fake/FakeCore.ts";
import { FakeEngine, type FakeEngineOptions } from "../engine/fake/FakeEngine.ts";
import type { Settings } from "../state/model.ts";

export interface FakeServicesOptions extends FakeEngineOptions {
  settings?: Partial<Settings>;
}

const live = new Set<FakeCore>();

export function fakeServices({ settings, ...engineOptions }: FakeServicesOptions = {}) {
  const engine = new FakeEngine({ stepMs: 50, ...engineOptions });
  const core = new FakeCore({ engine, settings, storage: globalThis.localStorage });
  live.add(core);
  return { engine, developer: engine, demo: engine, core };
}

/** Stops every core the last test made, so none keeps following its engine. */
export function disposeFakeServices(): void {
  for (const core of live) core.dispose();
  live.clear();
}
