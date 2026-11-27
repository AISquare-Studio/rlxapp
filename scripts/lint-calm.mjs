#!/usr/bin/env node
// The calm-design lint over every stylesheet and component in src/ (rule-calm-design.md). Run by
// `npm run lint`, on every OS in CI. The rules and the path handling live in
// src/theme/calmLint.ts, which vitest also tests (fixtures, and Windows-style paths).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lintCalm, lintInlineStyles, lintTargets } from "../src/theme/calmLint.ts";

// fileURLToPath, not URL.pathname: on Windows the pathname is '/D:/…', which joins to 'D:\D:\…'.
const root = fileURLToPath(new URL("..", import.meta.url));
const found = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => relative(root, join(d.parentPath, d.name)));
const { css, tsx } = lintTargets(found);

let failures = 0;
const report = (path, v) => {
  failures += 1;
  console.error(`${path}:${v.line}  ${v.rule}  ${v.text}`);
};
for (const path of css) {
  for (const v of lintCalm(readFileSync(join(root, path), "utf8"), path)) report(path, v);
}
for (const path of tsx) {
  for (const v of lintInlineStyles(readFileSync(join(root, path), "utf8"), path)) report(path, v);
}
if (failures) {
  console.error(`\ncalm lint: ${failures} problem(s). Use the design tokens in src/theme/tokens.css (see rule-calm-design).`);
  process.exit(1);
}
console.log(`calm lint: ${css.length} stylesheet(s) and ${tsx.length} component(s) clean`);
