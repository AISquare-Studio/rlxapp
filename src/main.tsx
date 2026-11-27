import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/tokens.css";
import { App } from "./App.tsx";
import { FakeCore } from "./core/fake/FakeCore.ts";
import { FakeEngine } from "./engine/fake/FakeEngine.ts";
import { whenFirstPaint } from "./platform/firstPaint.ts";
import { detectPlatform } from "./platform/index.ts";
import type { Settings } from "./state/model.ts";

// The composition root: the one place that chooses implementations. Until rlxd ships, the engine
// is the FakeEngine (also the Developer engine and the preview's demo controls), under a FakeCore.
const platform = detectPlatform();
const engine = new FakeEngine();
// The browser checks seed the fake host's settings through this (e2e/web/helpers.ts).
const seed = (globalThis as { rlxFakeHost?: Partial<Settings> }).rlxFakeHost;
const core = new FakeCore({ engine, settings: seed });

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
