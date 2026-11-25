// Shared by scripts/smoke-test.mjs and scripts/idle-memory.mjs: launch a built rlx binary
// with the startup probe enabled (RLXAPP_STARTUP_PROBE, see src-tauri/src/probe.rs) and
// follow it until it paints its first frame.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Starts `binary` and returns a handle:
 *   pid, startedAt, exited (null while running), waitForPaint(timeoutMs), stop(), cleanup().
 */
export function launchWithProbe(binary) {
  const workDir = mkdtempSync(join(tmpdir(), "rlx-probe-"));
  const probeFile = join(workDir, "probe.txt");
  const startedAt = Date.now();
  const child = spawn(binary, [], {
    env: { ...process.env, RLXAPP_STARTUP_PROBE: probeFile },
    stdio: "inherit",
  });

  const app = {
    pid: child.pid,
    startedAt,
    exited: null,

    /** Resolves with { atMs, source } once painted; rejects on exit or timeout. */
    async waitForPaint(timeoutMs) {
      for (;;) {
        const elapsed = Date.now() - startedAt;
        if (app.exited) throw new Error(describeExit(app.exited, elapsed));
        const match = readProbe(probeFile);
        if (match) return { atMs: elapsed, source: match[2] };
        if (elapsed > timeoutMs) throw new Error(`no first paint within ${timeoutMs / 1000} s`);
        await sleep(100);
      }
    },

    async stop() {
      if (app.exited) return;
      const gone = new Promise((done) => child.once("exit", done));
      child.kill();
      await Promise.race([gone, sleep(5000)]);
      if (!app.exited) child.kill("SIGKILL");
    },

    cleanup() {
      rmSync(workDir, { recursive: true, force: true });
    },
  };

  child.on("exit", (code, signal) => {
    app.exited = { code, signal };
  });
  child.on("error", (error) => {
    app.exited = { code: null, signal: null, error };
  });
  return app;
}

export function describeExit(exited, elapsedMs) {
  return exited.error
    ? `app failed to start: ${exited.error.message}`
    : `app exited after ${elapsedMs} ms (code ${exited.code}, signal ${exited.signal})`;
}

function readProbe(file) {
  try {
    return readFileSync(file, "utf8").match(/^first_paint epoch_ms=([\d.]+) source=(\w+)$/m);
  } catch {
    return null;
  }
}
