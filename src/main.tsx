import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/tokens.css";
import { App } from "./App.tsx";
import { whenFirstPaint } from "./platform/firstPaint.ts";
import { detectPlatform } from "./platform/index.ts";

const platform = detectPlatform();
const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element missing from index.html");
}

createRoot(root).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);

// Startup measurement hook; a no-op unless the core was launched with
// RLXAPP_STARTUP_PROBE set (see scripts/measure-budgets.sh).
whenFirstPaint()
  .then(({ epochMs, source }) => platform.reportFirstPaint(epochMs, source))
  .catch((error: unknown) => {
    console.error("first-paint report failed", error);
  });
