// Runs the widget isolation probe (docs/architecture.md §5.3) against an e2e test build and
// judges its report with probe-rules.mjs. It works the same on macOS, Windows and Linux
// (under xvfb), and needs no WebDriver: the app probes itself and writes a report.
//
//   node e2e/native/probe.mjs [<e2e binary>] [--timeout 240] [--rtc-kept]
//
// --rtc-kept runs it with frames.js's WebRTC removal skipped (RLXAPP_E2E_RTC=kept), to check
// what the widgets webview's network setup alone does with WebRTC; its results go to
// isolation-probe-<os>-webrtc-kept.*. With RLXAPP_E2E_DNS_PORT set (CI, with the probe's DNS
// zone routed to that port), the app also measures DNS (src-tauri/src/e2e/dns.rs).
//
// The binary must come from `npm run e2e:build` (cargo feature `e2e`). The run writes:
//   e2e/results/isolation-probe-<os>.json  the raw report plus the checks
//   e2e/results/isolation-probe-<os>.md    the checks as a table
// and appends the table to $GITHUB_STEP_SUMMARY in CI. The exit code is non-zero if any
// check fails.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { droppedRawMessages, evaluate, passed, redactKey, toMarkdown } from "./probe-rules.mjs";
import { defaultBinary, osName, repoRoot } from "./paths.mjs";
import { stopTree } from "./processes.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Launches `binary` with the probe on, waits for its report, stops it and judges the report.
 * @returns {Promise<{ ok: boolean, checks: ReturnType<typeof evaluate>, markdown: string }>}
 */
export async function runProbe({ binary = defaultBinary(), timeoutMs = 240_000, rtcKept = false, log = console.log } = {}) {
  binary = resolve(binary);
  if (!existsSync(binary)) throw new Error(`no e2e build at ${binary}; run \`npm run e2e:build\` first`);

  const work = mkdtempSync(join(tmpdir(), "rlx-isolation-"));
  const reportPath = join(work, "report.json");
  let stderr = "";
  log(`probe: launching ${binary}`);
  const child = spawn(binary, [], {
    env: { ...process.env, RLXAPP_E2E_REPORT: reportPath, ...(rtcKept ? { RLXAPP_E2E_RTC: "kept" } : {}) },
    stdio: ["ignore", "inherit", "pipe"],
  });
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  child.on("error", (error) => (exited = { error }));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const line of chunk.split(/\r?\n/)) if (line) process.stderr.write(`app: ${redactKey(line)}\n`);
  });

  const started = Date.now();
  let report = null;
  let failure = null;
  while (!report) {
    if (existsSync(reportPath)) {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
      break;
    }
    if (exited) {
      failure = exited.error ? `the app failed to start: ${exited.error.message}` : `the app exited during the probe (code ${exited.code}, signal ${exited.signal})`;
      break;
    }
    if (Date.now() - started > timeoutMs) {
      failure = `no report within ${timeoutMs / 1000} s`;
      break;
    }
    await sleep(250);
  }
  await stopTree(child, () => exited !== null);
  rmSync(work, { recursive: true, force: true });

  const checks = failure ? [{ id: "report", ok: false, blocking: true, detail: failure }] : evaluate(report, { stderr });
  const title = `Widget isolation probe (${osName()}${rtcKept ? ", WebRTC kept" : ""})`;
  const markdown = toMarkdown(title, checks);
  const ok = passed(checks);

  const results = join(repoRoot, "e2e", "results");
  mkdirSync(results, { recursive: true });
  const base = join(results, `isolation-probe-${osName()}${rtcKept ? "-webrtc-kept" : ""}`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ ok, checks, report, droppedRaw: droppedRawMessages(stderr) }, null, 2)}\n`);
  writeFileSync(`${base}.md`, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  for (const c of checks) log(`${c.info ? "info" : c.ok ? "PASS" : c.blocking ? "FAIL" : "GATE"}  ${c.id}: ${c.detail}`);
  const gated = checks.filter((c) => !c.ok && !c.blocking).length;
  log(`probe: ${ok ? "PASS" : "FAIL"} (${checks.filter((c) => !c.ok && c.blocking).length} failed, ${gated} keep agent-made widgets off); report in ${base}.json`);
  return { ok, checks, markdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { timeout: { type: "string", default: "240" }, "rtc-kept": { type: "boolean", default: false } },
  });
  const { ok } = await runProbe({ binary: positionals[0], timeoutMs: Number(values.timeout) * 1000, rtcKept: values["rtc-kept"] });
  process.exit(ok ? 0 : 1);
}
