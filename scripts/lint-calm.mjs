#!/usr/bin/env node
// The calm-design lint over every stylesheet in src/ (rule-calm-design.md). Run by `npm run lint`.
// The rules live in src/theme/calmLint.ts, which vitest also tests against fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { lintCalm } from "../src/theme/calmLint.ts";

const root = new URL("..", import.meta.url).pathname;
const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".css"))
  .map((d) => relative(root, join(d.parentPath, d.name)))
  .filter((path) => !path.includes("/fixtures/"));

let failures = 0;
for (const path of files.sort()) {
  for (const v of lintCalm(readFileSync(join(root, path), "utf8"), path)) {
    failures += 1;
    console.error(`${path}:${v.line}  ${v.rule}  ${v.text}`);
  }
}
if (failures) {
  console.error(`\ncalm lint: ${failures} problem(s). Use the design tokens in src/theme/tokens.css (see rule-calm-design).`);
  process.exit(1);
}
console.log(`calm lint: ${files.length} stylesheet(s) clean`);
