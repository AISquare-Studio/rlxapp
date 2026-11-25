#!/usr/bin/env node
// The calm-design lint over every stylesheet in src/ (rule-calm-design.md). Run by `npm run lint`.
// The rules live in src/theme/calmLint.ts, which vitest also tests against fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { lintCalm, lintInlineStyles } from "../src/theme/calmLint.ts";

const root = new URL("..", import.meta.url).pathname;
const all = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => relative(root, join(d.parentPath, d.name)))
  .filter((path) => !path.includes("/fixtures/"));
const files = all.filter((path) => path.endsWith(".css"));
const components = all.filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"));

let failures = 0;
for (const path of files.sort()) {
  for (const v of lintCalm(readFileSync(join(root, path), "utf8"), path)) {
    failures += 1;
    console.error(`${path}:${v.line}  ${v.rule}  ${v.text}`);
  }
}
for (const path of components.sort()) {
  for (const v of lintInlineStyles(readFileSync(join(root, path), "utf8"), path)) {
    failures += 1;
    console.error(`${path}:${v.line}  ${v.rule}  ${v.text}`);
  }
}
if (failures) {
  console.error(`\ncalm lint: ${failures} problem(s). Use the design tokens in src/theme/tokens.css (see rule-calm-design).`);
  process.exit(1);
}
console.log(`calm lint: ${files.length} stylesheet(s) and ${components.length} component(s) clean`);
