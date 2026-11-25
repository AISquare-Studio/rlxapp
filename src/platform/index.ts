/**
 * Platform adapter: what the UI needs from the host.
 *
 * Inside the Tauri webview, calls go to the Rust core through the engine adapter
 * (../engine/adapter/native.ts). In a plain browser (`npm run dev`, UI tests) Tauri's internals
 * are absent, so the adapter falls back to in-memory mocks and the UI still runs.
 */
import { isTauri } from "@tauri-apps/api/core";
import { nativeAppInfo, nativeReportFirstPaint } from "../engine/adapter/native.ts";

export type Runtime = "native" | "browser";

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  runtime: Runtime;
  /** Launched to measure the budgets: open on Home and save nothing. */
  measuring: boolean;
}

/** How the first-paint timestamp was obtained (see ./firstPaint.ts). */
export type PaintSource = "fcp" | "raf";

/**
 * How an agent-made widget renders here: inline HTML in a sandboxed iframe (the browser
 * preview), or not at all. In the app, the main window allows no frames (CSP frame-src 'none');
 * agent-made widgets live only in the separate `widgets` child webview that the widget host
 * (task #20) builds (architecture §5.3). Until it merges, the app shows a placeholder.
 */
export type WidgetSource = { srcdoc: string } | { off: string };

export const AGENT_WIDGETS_OFF =
  "Agent-made widgets are coming with the widget host. Until then they render only in the browser preview.";

export interface Platform {
  readonly runtime: Runtime;
  appInfo(): Promise<AppInfo>;
  /** Reports the first-paint wall-clock time (Unix epoch, ms) to the core for startup measurement. */
  reportFirstPaint(epochMs: number, source: PaintSource): Promise<void>;
  /** Hands a widget's HTML to the host and says how to load it in a sandboxed iframe. */
  widgetSource(id: string, version: number, html: string): Promise<WidgetSource>;
  /**
   * Says whether a main-window modal, menu, toast or notification covers Home. The widget host's
   * child webview paints above main's DOM, so it hides its tiles while covered (follow-up 7).
   */
  setWidgetsCovered(covered: boolean): void;
}

export const nativePlatform: Platform = {
  runtime: "native",
  async appInfo() {
    const info = await nativeAppInfo();
    return { ...info, runtime: "native" };
  },
  async reportFirstPaint(epochMs, source) {
    await nativeReportFirstPaint(epochMs, source);
  },
  widgetSource() {
    return Promise.resolve({ off: AGENT_WIDGETS_OFF });
  },
  setWidgetsCovered() {
    // No child webview yet: the widget host (#20) adds it, and its API is called here.
  },
};

export const browserPlatform: Platform = {
  runtime: "browser",
  appInfo() {
    return Promise.resolve({
      name: "rlx",
      version: __APP_VERSION__,
      os: "browser",
      arch: "n/a",
      runtime: "browser",
      measuring: false,
    });
  },
  reportFirstPaint() {
    return Promise.resolve();
  },
  widgetSource(_id, _version, html) {
    return Promise.resolve({ srcdoc: html });
  },
  setWidgetsCovered() {
    // The preview's widgets are main-window DOM, so an overlay already paints above them.
  },
};

/** Picks the native adapter inside Tauri, the mock adapter everywhere else. */
export function detectPlatform(): Platform {
  return isTauri() ? nativePlatform : browserPlatform;
}
