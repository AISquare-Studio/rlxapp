// Native end-to-end tests of the built app (`npm run e2e`).
//
//   npm run e2e:build          # the test build: cargo feature e2e, debug, no bundle
//   npm run e2e [-- --app <binary>] [--only probe|screens]
//
// 1. The widget isolation probe (probe.mjs), on every OS: the app probes itself and writes a
//    report, so it needs no WebDriver.
// 2. The screen checks in checks/ (one file per screen), on Windows and Linux: the app runs
//    under tauri-driver, and every check saves screenshots to e2e/screenshots/ as
//    <os>-<check>--<shot>.png. macOS has no WebDriver for WKWebView, so there
//    scripts/mac-native-check.sh covers the window, menus, close, reopen and quit instead.
//
// Set TAURI_NATIVE_DRIVER to the native driver's path (msedgedriver.exe on Windows) if it
// isn't on PATH. On Linux, run it under xvfb-run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runProbe } from "./probe.mjs";
import { defaultBinary, osName, repoRoot, screenshotsDir } from "./paths.mjs";
import { stopTree, waitForWebviewsToExit, webviewProcesses } from "./processes.mjs";
import { Session, startTauriDriver } from "./webdriver.mjs";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    only: { type: "string" },
    port: { type: "string", default: "4444" },
  },
});
const binary = resolve(values.app ?? defaultBinary());
const os = osName();
let failed = false;

if (!values.only || values.only === "probe") {
  const { ok } = await runProbe({ binary });
  failed ||= !ok;
}

if (!values.only || values.only === "screens") {
  if (os === "macos") {
    console.log("screens: macOS has no WebDriver for WKWebView; run scripts/mac-native-check.sh for the native checks.");
  } else {
    try {
      // Always run the screens, even after a probe failure (`||=` would skip them).
      const screensOk = await runScreens();
      failed = failed || !screensOk;
    } catch (error) {
      console.error(`FAIL  screens: ${error.message ?? error}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);

/**
 * Windows: msedgedriver's own launch of a WebView2 app waits for a DevToolsActivePort file
 * in the user-data folder it asked for. The app's WebView2 uses its own folder, so the
 * session times out. Microsoft's documented alternative: start the app with a remote
 * debugging port and attach msedgedriver to it (ms:edgeOptions.debuggerAddress).
 */
async function launchForAttach(app, env, port) {
  const child = spawn(app, [], {
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let exitCode = null;
  let output = "";
  const keep = (chunk) => (output = (output + chunk).slice(-1500));
  child.stdout.setEncoding("utf8").on("data", keep);
  child.stderr.setEncoding("utf8").on("data", keep);
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = signal ?? code;
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (exited || Date.now() > deadline) {
      await stopTree(child, () => exited);
      const portFile = join(process.env.LOCALAPPDATA ?? "", "studio.aisquare.rlx", "EBWebView", "DevToolsActivePort");
      throw new Error(
        `WebView2 never opened remote debugging on port ${port}${exited ? ` (the app exited: ${exitCode})` : ""}; ` +
          `the app's own DevToolsActivePort ${existsSync(portFile) ? "exists" : "doesn't exist"}; ` +
          `app output: ${output.trim().replaceAll(/\s+/g, " ") || "none"}`,
      );
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return { port, stop: () => stopTree(child, () => exited) };
}

/** The r\x mark's path data, read from the logo the app renders it from. */
function logoPaths() {
  const svg = readFileSync(join(repoRoot, "src", "assets", "rlx-logo.svg"), "utf8");
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
}

async function runScreens() {
  mkdirSync(screenshotsDir, { recursive: true });
  const checksDir = join(repoRoot, "e2e", "native", "checks");
  const files = readdirSync(checksDir).filter((f) => f.endsWith(".mjs")).sort();
  // The app runs without the probe here: the screens are the product's.
  const env = { ...process.env };
  delete env.RLXAPP_E2E_REPORT;
  // A WebView2 process left from an earlier launch would swallow the driver's launch.
  const lingering = await waitForWebviewsToExit();
  if (lingering.length > 0) console.log(`screens: ${lingering.length} WebView2 process(es) still running before tauri-driver:\n${lingering.join("\n")}`);
  const driver = await startTauriDriver({ port: Number(values.port), nativeDriver: process.env.TAURI_NATIVE_DRIVER, env });
  const results = [];
  try {
    for (const file of files) {
      const check = await import(pathToFileURL(join(checksDir, file)).href);
      const label = check.name ?? file.replace(/\.mjs$/, "");
      const saved = [];
      let session;
      let attached = null;
      const started = Date.now();
      try {
        // A fresh app per check, so one check's state never leaks into the next.
        if (os === "windows") {
          attached = await launchForAttach(binary, env, 9222 + results.length);
          session = await Session.withCapabilities(driver.base, {
            browserName: "webview2",
            "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${attached.port}` },
          });
        } else {
          session = await Session.create(driver.base, binary);
        }
        const save = (png, shotName) => {
          const path = join(screenshotsDir, `${os}-${label}--${shotName}.png`);
          writeFileSync(path, png);
          saved.push(path);
        };
        await check.run({
          session,
          assert,
          os,
          logoPaths: logoPaths(),
          shot: async (shotName) => save(await session.screenshot(), shotName),
          shotElement: async (element, shotName) => save(await session.elementScreenshot(element), shotName),
        });
        results.push({ label, ok: true, detail: `${saved.length} screenshot(s)`, ms: Date.now() - started });
      } catch (error) {
        if (session) {
          try {
            const path = join(screenshotsDir, `${os}-${label}--failure.png`);
            writeFileSync(path, await session.screenshot());
            saved.push(path);
          } catch {
            // no screenshot of a session that never started
          }
        }
        const left = webviewProcesses();
        const note = left.length > 0 ? ` [${left.length} WebView2 process(es) running]` : "";
        results.push({ label, ok: false, detail: `${String(error.message ?? error)}${note}`, ms: Date.now() - started });
      } finally {
        await session?.delete();
        await attached?.stop();
      }
    }
  } finally {
    await driver.stop();
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  screen ${r.label} (${r.ms} ms): ${r.detail}`);
  const summary = [
    `### Native screen checks (${os}, tauri-driver): ${results.every((r) => r.ok) ? "PASS" : "FAIL"}`,
    "",
    "| | Check | Detail |",
    "| --- | --- | --- |",
    ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.label} | ${r.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  return results.length > 0 && results.every((r) => r.ok);
}
