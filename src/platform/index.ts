/**
 * Platform adapter: what the UI needs from the host.
 *
 * Inside the Tauri webview, calls go to the Rust core through the engine adapter
 * (../engine/adapter/native.ts). In a plain browser (`npm run dev`, UI tests) Tauri's internals
 * are absent, so the adapter falls back to in-memory mocks and the UI still runs.
 */
import { isTauri } from "@tauri-apps/api/core";
import {
  nativeAppInfo,
  nativeOnWidgetAction,
  nativeReportFirstPaint,
  nativeWidgetsHide,
  nativeWidgetsMount,
  nativeWidgetsPolicy,
  nativeWidgetsPush,
  nativeWidgetsRegister,
  nativeWidgetsShow,
} from "../engine/adapter/native.ts";
import { WidgetHost, parsePolicy, type WidgetPolicy } from "./widgetHost.ts";

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
 * How an agent-made widget renders here:
 * - `srcdoc`: inline, in a sandboxed iframe (the browser preview only);
 * - `host`: in the `widgets` child webview, laid over its tile (architecture §5.3). The main
 *   window allows no frames (CSP frame-src 'none');
 * - `off`: not at all, with the reason. The policy keeps agent-made widgets off on every OS
 *   until the isolation probe passes there and the owner turns them on.
 */
export type WidgetSource = { srcdoc: string } | { host: { id: string; version: number } } | { off: string };

export interface Platform {
  readonly runtime: Runtime;
  appInfo(): Promise<AppInfo>;
  /** Reports the first-paint wall-clock time (Unix epoch, ms) to the core for startup measurement. */
  reportFirstPaint(epochMs: number, source: PaintSource): Promise<void>;
  /** Where widgets render here, and whether agent-made ones may. */
  widgetPolicy(): Promise<WidgetPolicy>;
  /** Hands an agent-made widget's HTML to the host and says how it renders. */
  widgetSource(id: string, version: number, html: string): Promise<WidgetSource>;
  /** The widgets webview, where this OS has one (native only). */
  readonly widgetHost?: WidgetHost;
  /**
   * Says whether a main-window menu, modal, toast or notification covers Home. The widgets
   * webview draws above main's DOM, so it hides while covered (follow-up 7).
   */
  setWidgetsCovered(covered: boolean): void;
}

const nativeWidgetHost = new WidgetHost({
  show: nativeWidgetsShow,
  hide: nativeWidgetsHide,
  mount: nativeWidgetsMount,
  push: nativeWidgetsPush,
  register: nativeWidgetsRegister,
  onAction: nativeOnWidgetAction,
});

let nativePolicy: Promise<WidgetPolicy> | null = null;

/** The core's policy, read once: it can't change while the app runs. */
function readNativePolicy(): Promise<WidgetPolicy> {
  nativePolicy ??= nativeWidgetsPolicy().then(parsePolicy);
  return nativePolicy;
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
  widgetPolicy: readNativePolicy,
  async widgetSource(id, version, html) {
    const policy = await readNativePolicy();
    if (!policy.agentWidgets.on) return { off: policy.agentWidgets.reason };
    if (!policy.widgetWebview) return { off: "this device has no widget webview yet" };
    await nativeWidgetHost.register(id, version, html);
    return { host: { id, version } };
  },
  widgetHost: nativeWidgetHost,
  setWidgetsCovered(covered) {
    void nativeWidgetHost.setCovered(covered);
  },
};

/** The browser preview: no widget webview; agent-made widgets render inline, sandboxed. */
const BROWSER_POLICY: WidgetPolicy = { widgetWebview: false, builtins: "main", agentWidgets: { on: true } };

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
  widgetPolicy() {
    return Promise.resolve(BROWSER_POLICY);
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
