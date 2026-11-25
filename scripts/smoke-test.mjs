#!/usr/bin/env node
// Smoke test for a built rlxapp binary, used by CI on macOS, Windows and Linux (under xvfb).
//
//   node scripts/smoke-test.mjs <path-to-binary> [--min-seconds 5] [--paint-timeout 60]
//
// It launches the binary with the startup probe enabled (RLXAPP_STARTUP_PROBE, see
// src-tauri/src/probe.rs) and passes only if both of these hold:
//   - the web UI painted its first frame and reported it over IPC, which proves that
//     the webview (WebKit, WebView2 or WebKitGTK) loaded the bundled frontend; and
//   - the process is still alive after --min-seconds.
// It fails if the app exits or crashes, or if it doesn't paint within --paint-timeout.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

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

const workDir = mkdtempSync(join(tmpdir(), "rlxapp-smoke-"));
const probeFile = join(workDir, "probe.txt");

console.log(`smoke: launching ${binary}`);
const startedAt = Date.now();
const child = spawn(binary, [], {
  env: { ...process.env, RLXAPP_STARTUP_PROBE: probeFile },
  stdio: "inherit",
});

let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});
child.on("error", (error) => {
  exited = { code: null, signal: null, error };
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readPaint() {
  try {
    return readFileSync(probeFile, "utf8").match(/^first_paint epoch_ms=([\d.]+) source=(\w+)$/m);
  } catch {
    return null;
  }
}

async function stop() {
  if (exited) return;
  const gone = new Promise((done) => child.once("exit", done));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
  if (!exited) child.kill("SIGKILL");
}

function finish(code, message) {
  (code === 0 ? console.log : console.error)(`smoke: ${message}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(code);
}

let paint = null;
for (;;) {
  const elapsed = Date.now() - startedAt;
  if (exited) {
    const how = exited.error
      ? `failed to start: ${exited.error.message}`
      : `exited after ${elapsed} ms (code ${exited.code}, signal ${exited.signal})`;
    finish(1, `FAIL: app ${how}${paint ? "" : " before its first paint"}`);
  }
  if (!paint) {
    const match = readPaint();
    if (match) {
      paint = { atMs: elapsed, source: match[2] };
      console.log(`smoke: first paint reported after ~${elapsed} ms (${match[2]})`);
    } else if (elapsed > paintTimeoutMs) {
      await stop();
      finish(1, `FAIL: no first paint within ${paintTimeoutMs / 1000} s`);
    }
  }
  if (paint && elapsed >= minMs) break;
  await sleep(100);
}

const aliveMs = Date.now() - startedAt;
await stop();
finish(0, `PASS: painted and stayed up for ${(aliveMs / 1000).toFixed(1)} s`);
