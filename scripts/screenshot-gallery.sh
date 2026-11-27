#!/usr/bin/env bash
# Turns the native e2e screenshots into a markdown gallery for a PR body.
#
#   scripts/screenshot-gallery.sh [--run RUN_ID] [--copy-to DIR] [--base-url URL]
#                                 [--out FILE] [DIR...]
#
#   --run RUN_ID   first download the run's e2e-screenshots-<os> artifacts (one
#                  `gh run download` call) into e2e/screenshots/ci/<os>/
#   --copy-to DIR  copy every image into DIR (e.g. docs/gallery/native), so they can be
#                  committed and linked; links then point into DIR
#   --base-url URL prefix for image links. GitHub can't show local files in a PR body, so
#                  point this at where the images are hosted, e.g.
#                  https://raw.githubusercontent.com/<owner>/<repo>/<sha>/docs/gallery/native
#                  Without it, links are relative paths (fine for a local preview).
#   --out FILE     write the markdown there as well as to stdout
#   DIR...         where to look for PNGs (default: e2e/screenshots, which includes ci/)
#
# Images are grouped by OS from their file name, <os>-<check>--<shot>.png, as written by
# e2e/native/run.mjs (Windows, Linux) and scripts/mac-native-check.sh (macOS). CI's
# isolation-probe tables, when downloaded with the artifacts, are added under the images.
set -euo pipefail
cd "$(dirname "$0")/.."

run=""
copy_to=""
base_url=""
out=""
dirs=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) run=$2; shift ;;
    --copy-to) copy_to=$2; shift ;;
    --base-url) base_url=$2; shift ;;
    --out) out=$2; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) dirs+=("$1") ;;
  esac
  shift
done
[[ ${#dirs[@]} -gt 0 ]] || dirs=(e2e/screenshots)

if [[ -n "$run" ]]; then
  dest=e2e/screenshots/ci
  rm -rf "$dest"
  mkdir -p "$dest"
  # One API call for all of the run's screenshot artifacts; each lands in $dest/<name>/.
  gh run download "$run" --pattern 'e2e-screenshots-*' --dir "$dest" >&2
  echo "gallery: downloaded run $run's screenshots into $dest" >&2
fi

RUN="$run" COPY_TO="$copy_to" BASE_URL="$base_url" OUT="$out" node --input-type=module - "${dirs[@]}" <<'NODE'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const { RUN, COPY_TO, BASE_URL, OUT } = process.env;
const ORDER = ["macos", "windows", "linux"];
const TITLES = { macos: "macOS", windows: "Windows", linux: "Linux" };

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [...new Set(process.argv.slice(2).flatMap(walk))];
const images = files.filter((f) => f.endsWith(".png"));
const tables = files.filter((f) => /isolation-probe-\w+\.md$/.test(f));
if (images.length === 0) {
  console.error("gallery: no screenshots found; run `npm run e2e` or scripts/mac-native-check.sh first");
  process.exit(1);
}

// Newest copy wins when the same shot exists locally and from CI.
const byName = new Map();
for (const path of images) {
  const name = basename(path);
  const seen = byName.get(name);
  if (!seen || statSync(path).mtimeMs > statSync(seen).mtimeMs) byName.set(name, path);
}

if (COPY_TO) mkdirSync(COPY_TO, { recursive: true });
const link = (path) => {
  let target = path;
  if (COPY_TO) {
    target = join(COPY_TO, basename(path));
    copyFileSync(path, target);
  }
  if (BASE_URL) return `${BASE_URL.replace(/\/$/, "")}/${encodeURI(basename(target))}`;
  return relative(process.cwd(), target).split("\\").join("/");
};

const groups = new Map();
for (const [name, path] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
  const stem = name.replace(/\.png$/, "");
  const os = stem.split("-")[0];
  const [check, shot] = stem.slice(os.length + 1).split("--");
  const caption = shot ? `${check.replaceAll("-", " ")}: ${shot.replaceAll("-", " ")}` : check.replaceAll("-", " ");
  const key = ORDER.includes(os) ? os : "other";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ caption: caption || name, url: link(path) });
}

const lines = ["## Screenshot gallery", ""];
const sources = [];
if (groups.has("macos")) sources.push("macOS from scripts/mac-native-check.sh (window-only `screencapture -l`)");
if (groups.has("windows") || groups.has("linux")) sources.push(`Windows/Linux from tauri-driver in CI${RUN ? ` (run ${RUN})` : ""}`);
lines.push(`<sub>${byName.size} screenshots · ${sources.join(" · ")}</sub>`, "");

for (const os of [...ORDER, "other"]) {
  const shots = groups.get(os);
  if (!shots) continue;
  lines.push(`### ${TITLES[os] ?? "Other"}`, "");
  for (let i = 0; i < shots.length; i += 3) {
    const row = shots.slice(i, i + 3);
    lines.push(`| ${row.map((s) => s.caption).join(" | ")} |`);
    lines.push(`| ${row.map(() => "---").join(" | ")} |`);
    lines.push(`| ${row.map((s) => `<img src="${s.url}" width="300" alt="${TITLES[os] ?? os} ${s.caption}">`).join(" | ")} |`);
    lines.push("");
  }
}

for (const table of tables.sort()) {
  lines.push("<details><summary>" + basename(table, ".md") + "</summary>", "", readFileSync(table, "utf8").trim(), "", "</details>", "");
}

const markdown = `${lines.join("\n").trim()}\n`;
if (OUT) writeFileSync(OUT, markdown);
process.stdout.write(markdown);
NODE
