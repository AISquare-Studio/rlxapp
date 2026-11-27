// Paths and names shared by the native e2e scripts.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The OS name used in artifact and screenshot names: macos, windows or linux. */
export function osName() {
  return { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] ?? process.platform;
}

/** Where `npm run e2e:build` puts the test build. */
export function defaultBinary() {
  const exe = process.platform === "win32" ? "rlxapp.exe" : "rlxapp";
  return join(repoRoot, "src-tauri", "target", "debug", exe);
}

export const screenshotsDir = join(repoRoot, "e2e", "screenshots");
