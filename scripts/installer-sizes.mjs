#!/usr/bin/env node
// Prints a Markdown table of the installers in src-tauri/target/release/bundle/: the .dmg,
// .msi, setup .exe, .deb, .rpm and .AppImage files, with their sizes in MB (10^6 bytes).
// CI appends the table to the job summary. The installer budget is <= 25 MB.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const bundleDir = join(import.meta.dirname, "..", "src-tauri", "target", "release", "bundle");
const installer = /\.(dmg|msi|exe|deb|rpm|AppImage)$/;

const rows = [];
if (existsSync(bundleDir)) {
  for (const kind of readdirSync(bundleDir)) {
    const dir = join(bundleDir, kind);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const { size } = statSync(file);
      if (statSync(file).isFile() && installer.test(name)) {
        rows.push(`| ${name} | ${(size / 1e6).toFixed(2)} MB | ${size} |`);
      }
    }
  }
}

if (rows.length === 0) {
  console.error(`installer-sizes: no installers under ${bundleDir}`);
  process.exit(1);
}
console.log(["| installer | size | bytes |", "| --- | ---: | ---: |", ...rows.sort()].join("\n"));
