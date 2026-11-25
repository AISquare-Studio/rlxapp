/**
 * Platform adapter: the only place the UI talks to Tauri.
 *
 * Inside the Tauri webview, calls go to the Rust core over IPC. In a plain
 * browser (`npm run dev`, UI tests) Tauri's internals are absent, so the
 * adapter falls back to in-memory mocks and the UI still runs.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Runtime = "native" | "browser";

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  runtime: Runtime;
}

/** How the first-paint timestamp was obtained (see ./firstPaint.ts). */
export type PaintSource = "fcp" | "raf";

export interface Platform {
  readonly runtime: Runtime;
  appInfo(): Promise<AppInfo>;
  /** Reports the first-paint wall-clock time (Unix epoch, ms) to the core for startup measurement. */
  reportFirstPaint(epochMs: number, source: PaintSource): Promise<void>;
}

/** Shape returned by the Rust `app_info` command (src-tauri/src/lib.rs). */
type NativeAppInfo = Omit<AppInfo, "runtime">;

export const nativePlatform: Platform = {
  runtime: "native",
  async appInfo() {
    const info = await invoke<NativeAppInfo>("app_info");
    return { ...info, runtime: "native" };
  },
  async reportFirstPaint(epochMs, source) {
    await invoke("report_first_paint", { epochMs, source });
  },
};

export const browserPlatform: Platform = {
  runtime: "browser",
  appInfo() {
    return Promise.resolve({
      name: "rlxapp",
      version: __APP_VERSION__,
      os: "browser",
      arch: "n/a",
      runtime: "browser",
    });
  },
  reportFirstPaint() {
    return Promise.resolve();
  },
};

/** Picks the native adapter inside Tauri, the mock adapter everywhere else. */
export function detectPlatform(): Platform {
  return isTauri() ? nativePlatform : browserPlatform;
}
