#!/usr/bin/env node
// Installer size gate, run by CI on every OS. The installer budget is <= 25 MB
// (25,000,000 bytes; MB = 10^6 bytes).
//
//   node scripts/installer-sizes.mjs [--dir <bundle dir>] [--limit <bytes>]
//
// Prints a Markdown table of every installer under the bundle directory (default
// src-tauri/target/release/bundle/), with its size and verdict. CI appends the table to the
// job summary. Then it exits:
//   1 if any gated installer is over the limit: .dmg, .msi, setup .exe, .deb or .rpm;
//   1 if there are no installers at all;
//   0 otherwise.
// The .AppImage is printed but never gated: it bundles WebKitGTK and its libraries, so it
// can't fit the budget.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const LIMIT_BYTES = 25_000_000;
const GATED = /\.(dmg|msi|exe|deb|rpm)$/;
const REPORT_ONLY = /\.AppImage$/;

/** The installer files one level below `bundleDir` (dmg/, msi/, nsis/, deb/, rpm/, appimage/). */
export function findInstallers(bundleDir) {
  const found = [];
  if (!existsSync(bundleDir)) return found;
  for (const kind of readdirSync(bundleDir)) {
    const dir = join(bundleDir, kind);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const stat = statSync(join(dir, name));
      if (stat.isFile() && (GATED.test(name) || REPORT_ONLY.test(name))) {
        found.push({ name, size: stat.size });
      }
    }
  }
  // Code-point order: the same on every OS and locale.
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Adds `gated` and `verdict` ("OK", "OVER" or "report only") to each installer. */
export function evaluate(installers, limit = LIMIT_BYTES) {
  return installers.map((installer) => {
    const gated = GATED.test(installer.name);
    const verdict = !gated ? "report only" : installer.size <= limit ? "OK" : "OVER";
    return { ...installer, gated, verdict };
  });
}

export function toMarkdown(rows, limit = LIMIT_BYTES) {
  return [
    `| installer | size | bytes | <= ${(limit / 1e6).toFixed(0)} MB |`,
    "| --- | ---: | ---: | --- |",
    ...rows.map((r) => `| ${r.name} | ${(r.size / 1e6).toFixed(2)} MB | ${r.size} | ${r.verdict} |`),
  ].join("\n");
}

function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: join(import.meta.dirname, "..", "src-tauri", "target", "release", "bundle") },
      limit: { type: "string", default: String(LIMIT_BYTES) },
    },
  });
  const bundleDir = resolve(values.dir);
  const limit = Number(values.limit);

  const rows = evaluate(findInstallers(bundleDir), limit);
  if (rows.length === 0) {
    console.error(`installer-sizes: no installers under ${bundleDir}`);
    return 1;
  }
  console.log(toMarkdown(rows, limit));

  const over = rows.filter((r) => r.verdict === "OVER");
  for (const r of over) {
    console.error(`installer-sizes: ${r.name} is ${r.size} bytes, over the ${limit}-byte budget`);
  }
  return over.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
