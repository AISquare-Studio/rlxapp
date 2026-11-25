#!/usr/bin/env node
// Smoke test for a built rlx binary, used by CI on macOS, Windows and Linux (under xvfb).
//
//   node scripts/smoke-test.mjs <path-to-binary> [--min-seconds 5] [--paint-timeout 60]
//
// It launches the binary with the startup probe enabled (RLXAPP_STARTUP_PROBE, see
// src-tauri/src/probe.rs) and passes only if both of these hold:
//   - the web UI painted its first frame and reported it over IPC, which proves that
//     the webview (WebKit, WebView2 or WebKitGTK) loaded the bundled frontend; and
//   - the process is still alive after --min-seconds.
// It fails if the app exits or crashes, or if it doesn't paint within --paint-timeout.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeExit, launchWithProbe, sleep } from "./lib/launch.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "min-seconds": { type: "string", default: "5" },
    "paint-timeout": { type: "string", default: "60" },
  },
});

const [binaryArg] = positionals;
if (!binaryArg) {
  console.error("usage: node scripts/smoke-test.mjs <path-to-binary> [--min-seconds 5] [--paint-timeout 60]");
  process.exit(2);
}
const binary = resolve(binaryArg);
if (!existsSync(binary)) {
  console.error(`smoke: binary not found: ${binary}`);
  process.exit(2);
}
const minMs = Number(values["min-seconds"]) * 1000;
const paintTimeoutMs = Number(values["paint-timeout"]) * 1000;

console.log(`smoke: launching ${binary}`);
const app = launchWithProbe(binary);

async function finish(code, message) {
  await app.stop();
  app.cleanup();
  (code === 0 ? console.log : console.error)(`smoke: ${message}`);
  process.exit(code);
}

try {
  const paint = await app.waitForPaint(paintTimeoutMs);
  console.log(`smoke: first paint reported after ~${paint.atMs} ms (${paint.source})`);
} catch (error) {
  await finish(1, `FAIL: ${error.message}${app.exited ? " before its first paint" : ""}`);
}

while (Date.now() - app.startedAt < minMs) {
  if (app.exited) await finish(1, `FAIL: ${describeExit(app.exited, Date.now() - app.startedAt)}`);
  await sleep(100);
}
if (app.exited) await finish(1, `FAIL: ${describeExit(app.exited, Date.now() - app.startedAt)}`);

await finish(0, `PASS: painted and stayed up for ${((Date.now() - app.startedAt) / 1000).toFixed(1)} s`);
