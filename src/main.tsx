import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/tokens.css";
import { App } from "./App.tsx";
import { DeviceStore, deviceStorage } from "./core/device.ts";
import { FakeCore } from "./core/fake/FakeCore.ts";
import { openFakeHost } from "./core/fake/hostStore.ts";
import { FakeEngine } from "./engine/fake/FakeEngine.ts";
import { whenFirstPaint } from "./platform/firstPaint.ts";
import { detectPlatform } from "./platform/index.ts";
import type { Settings } from "./state/model.ts";

// The composition root: the one place that chooses implementations. Until rlxd ships, the engine
// is the FakeEngine (also the Developer engine and the preview's demo controls), under a FakeCore
// whose host keeps its settings and agents in the browser's storage under its own key.
const platform = detectPlatform();
const storage = deviceStorage();
// The device's settings outlive any one host's core (sessions switch hosts).
const device = new DeviceStore(storage);
// Migrates rc's old settings key first; a migration that can't finish keeps this launch's host in memory.
const host = openFakeHost(storage, device);
const engine = new FakeEngine();
// The browser checks seed the fake host's settings through this (e2e/web/helpers.ts).
const seed = (globalThis as { rlxFakeHost?: Partial<Settings> }).rlxFakeHost;
const core = new FakeCore({ engine, device, host, settings: seed });

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element missing from index.html");
}

createRoot(root).render(
  <StrictMode>
    <App platform={platform} core={core} engine={engine} developer={engine} demo={engine} />
  </StrictMode>,
);

// Startup measurement hook; a no-op unless the core was launched with
// RLXAPP_STARTUP_PROBE set (see scripts/measure-budgets.sh).
whenFirstPaint()
  .then(({ epochMs, source }) => platform.reportFirstPaint(epochMs, source))
  .catch((error: unknown) => {
    console.error("first-paint report failed", error);
  });
