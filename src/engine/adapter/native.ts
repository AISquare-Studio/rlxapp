/**
 * The engine adapter's native side: the only module that calls into the Rust core over Tauri IPC.
 * `grep -rn "invoke(" src` matches only here (acceptance 9).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

// ---- the widget host (src-tauri/src/widget_host; main webview only) ----------------------

/** `widgets_policy`: where widgets render on this OS, and the agent-widget switch. */
export interface NativeWidgetPolicy {
  widgetWebview: boolean;
  builtins: "widgets" | "main";
  /** `"on"`, or `"off: <reason>"`. */
  agentWidgets: string;
}

/** Logical px relative to the window: where the widgets webview goes. */
export interface WidgetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetMountEntry {
  id: string;
  version: number;
  title: string;
}

/** An accepted widget action (`widget-action` event): `{ widgetId, message }`. */
export interface WidgetAction {
  widgetId: string;
  message: unknown;
}

export function nativeWidgetsPolicy(): Promise<NativeWidgetPolicy> {
  return invoke<NativeWidgetPolicy>("widgets_policy");
}

export async function nativeWidgetsShow(bounds: WidgetBounds): Promise<void> {
  await invoke("widgets_show", { bounds });
}

export async function nativeWidgetsHide(): Promise<void> {
  await invoke("widgets_hide");
}

export function nativeWidgetsMount(widgets: WidgetMountEntry[]): Promise<string[]> {
  return invoke<string[]>("widgets_mount", { widgets });
}

export async function nativeWidgetsPush(id: string, data: unknown): Promise<void> {
  await invoke("widgets_push", { id, data });
}

/** Agent-made HTML; the core refuses it while the switch is off. Returns the widget's URL. */
export function nativeWidgetsRegister(id: string, version: number, html: string): Promise<string> {
  return invoke<string>("widgets_register", { id, version, html });
}

/** Follows accepted widget actions. Returns a function that stops following. */
export function nativeOnWidgetAction(onAction: (action: WidgetAction) => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen<WidgetAction>("widget-action", (event) => onAction(event.payload)).then((unlisten) => {
    if (stopped) unlisten();
    else stop = unlisten;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}
