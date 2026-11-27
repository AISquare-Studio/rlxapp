#!/usr/bin/env node
// Idle memory of a built rlx binary on Linux and Windows. CI runs it; on macOS, use
// scripts/measure-budgets.sh.
//
//   node scripts/idle-memory.mjs <path-to-binary> [--runs 3] [--idle-seconds 30] [--paint-timeout 60]
//
// Method: rlx's idle-RAM measure, budget <= 150 MB (MB = 10^6 bytes).
//   Each run launches the binary with the startup probe and waits for its first paint.
//   It then leaves the default window open and idle for --idle-seconds, and sums the
//   memory of the app process and all of its descendants:
//     Linux    PSS from /proc/<pid>/smaps_rollup. The descendants are the WebKitGTK
//              web and network processes, and any bubblewrap sandbox around them.
//     Windows  private working set from Win32_PerfFormattedData_PerfProc_Process. The
//              descendants are the msedgewebview2.exe browser, renderer, GPU and
//              utility processes.
//   The figure reported against the budget is the median of the runs. RSS on Linux and
//   the full working set on Windows are printed as secondary numbers; both count
//   shared pages again in every process.
// When GITHUB_STEP_SUMMARY is set, a Markdown table is appended to it.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWithProbe, sleep } from "./lib/launch.mjs";

const BUDGET_MB = 150;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "3" },
    "idle-seconds": { type: "string", default: "30" },
    "paint-timeout": { type: "string", default: "60" },
  },
});

const MEASURES = {
  linux: { primary: "PSS", secondary: "RSS", sample: sampleLinux },
  win32: { primary: "private working set", secondary: "working set", sample: sampleWindows },
};
const measure = MEASURES[process.platform];
if (!measure) {
  console.error(`idle-memory: ${process.platform} is not supported here; on macOS run scripts/measure-budgets.sh`);
  process.exit(2);
}

const binary = resolve(positionals[0] ?? "");
if (!positionals[0] || !existsSync(binary)) {
  console.error("usage: node scripts/idle-memory.mjs <path-to-binary> [--runs 3] [--idle-seconds 30]");
  process.exit(2);
}
const runs = Number(values.runs);
const idleMs = Number(values["idle-seconds"]) * 1000;
const paintTimeoutMs = Number(values["paint-timeout"]) * 1000;

const mb = (bytes) => (bytes / 1e6).toFixed(2);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const results = [];
for (let run = 1; run <= runs; run++) {
  const app = launchWithProbe(binary);
  try {
    await app.waitForPaint(paintTimeoutMs);
    await sleep(idleMs);
    if (app.exited) throw new Error("the app exited during the idle period");
    const processes = measure.sample(app.pid);
    const primary = processes.reduce((sum, p) => sum + p.primary, 0);
    const secondary = processes.reduce((sum, p) => sum + p.secondary, 0);
    results.push({ primary, secondary, processes });
    console.log(
      `run ${run}: ${measure.primary} ${mb(primary)} MB, ${measure.secondary} ${mb(secondary)} MB, ${processes.length} processes`,
    );
  } catch (error) {
    console.error(`idle-memory: run ${run} failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await app.stop();
    app.cleanup();
  }
  if (process.exitCode) process.exit(process.exitCode);
  await sleep(2000); // let the webview processes exit before the next launch
}

const primaryMedian = median(results.map((r) => r.primary));
const secondaryMedian = median(results.map((r) => r.secondary));
const verdict = primaryMedian / 1e6 <= BUDGET_MB ? "OK" : "OVER";
const first = results[0];

console.log("run 1 by process:");
for (const p of first.processes) {
  console.log(`  ${p.name.padEnd(28)} ${String(p.pid).padStart(7)} ${mb(p.primary).padStart(9)} MB ${mb(p.secondary).padStart(9)} MB`);
}
const summaryLine = `median ${measure.primary} ${mb(primaryMedian)} MB (budget <= ${BUDGET_MB} MB: ${verdict}); median ${measure.secondary} ${mb(secondaryMedian)} MB (secondary), ${runs} run(s), ${values["idle-seconds"]} s idle`;
console.log(summaryLine);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `### Idle memory (${process.platform}): ${summaryLine}`,
    "",
    `| run 1 process | pid | ${measure.primary} MB | ${measure.secondary} MB |`,
    "| --- | ---: | ---: | ---: |",
    ...first.processes.map((p) => `| ${p.name} | ${p.pid} | ${mb(p.primary)} | ${mb(p.secondary)} |`),
    "",
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/** The app process and all its descendants, by parent PID, with PSS and RSS. */
function sampleLinux(rootPid) {
  const parentOf = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // Fields after "(comm)": state, ppid, ...
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parentOf.set(Number(entry), Number(fields[1]));
    } catch {
      // The process exited while we were listing.
    }
  }
  const pids = descendantsOf(rootPid, parentOf);
  return pids.map((pid) => {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (key) => {
      const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(rollup);
      if (!match) throw new Error(`no ${key} in /proc/${pid}/smaps_rollup`);
      return Number(match[1]) * 1024;
    };
    const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return { pid, name, primary: kb("Pss"), secondary: kb("Rss") };
  });
}

/** The app process and all its descendants, with private and full working sets. */
function sampleWindows(rootPid) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add(${Number(rootPid)})
    do {
      $added = $false
      foreach ($p in $procs) {
        if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
          [void]$ids.Add([int]$p.ProcessId); $added = $true
        }
      }
    } while ($added)
    $rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
      Where-Object { $ids.Contains([int]$_.IDProcess) } |
      ForEach-Object { [pscustomobject]@{ pid = [int]$_.IDProcess; name = [string]$_.Name; primary = [int64]$_.WorkingSetPrivate; secondary = [int64]$_.WorkingSet } })
    ConvertTo-Json -InputObject $rows -Compress
  `;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const rows = JSON.parse(out);
  if (!rows.some((row) => row.pid === Number(rootPid))) {
    throw new Error(`no performance data for the app process ${rootPid}`);
  }
  return rows;
}

function descendantsOf(rootPid, parentOf) {
  const found = [rootPid];
  for (let i = 0; i < found.length; i++) {
    for (const [pid, ppid] of parentOf) {
      if (ppid === found[i] && !found.includes(pid)) found.push(pid);
    }
  }
  return found;
}
