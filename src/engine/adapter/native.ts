/**
 * The engine adapter's native side: the only module that calls into the Rust core over Tauri IPC.
 * `grep -rn "invoke(" src` matches only here (acceptance 9).
 */
import { invoke } from "@tauri-apps/api/core";

/** Shape returned by the Rust `app_info` command (src-tauri/src/lib.rs). */
export interface NativeAppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  /** Launched under the startup probe, to measure the budgets. */
  measuring: boolean;
}

export function nativeAppInfo(): Promise<NativeAppInfo> {
  return invoke<NativeAppInfo>("app_info");
}

export async function nativeReportFirstPaint(epochMs: number, source: string): Promise<void> {
  await invoke("report_first_paint", { epochMs, source });
}
