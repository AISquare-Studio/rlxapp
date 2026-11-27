/**
 * The UI side of the widget host (architecture §5.3, src-tauri/src/widget_host). Agent-made
 * widgets render only in the `widgets` child webview, laid over their tile. That webview always
 * draws above the main webview, so it hides while a menu, modal, toast or notification covers
 * Home, and shows again, at the tile's current bounds, once nothing does.
 */
import type { WidgetAction, WidgetBounds, WidgetMountEntry } from "../engine/adapter/native.ts";

export type { WidgetAction, WidgetBounds, WidgetMountEntry };

/** Where widgets render here, and whether agent-made ones may. */
export interface WidgetPolicy {
  /** Whether this OS has the `widgets` child webview. */
  widgetWebview: boolean;
  /** Where built-in widgets render: the widgets webview, or escaped React in main. */
  builtins: "widgets" | "main";
  agentWidgets: { on: true } | { on: false; reason: string };
}

/** `widgets_policy`'s answer, as the UI uses it. */
export function parsePolicy(raw: { widgetWebview: boolean; builtins: "widgets" | "main"; agentWidgets: string }): WidgetPolicy {
  const agentWidgets: WidgetPolicy["agentWidgets"] =
    raw.agentWidgets === "on" ? { on: true } : { on: false, reason: raw.agentWidgets.replace(/^off:\s*/, "") };
  return { widgetWebview: raw.widgetWebview, builtins: raw.builtins, agentWidgets };
}

/** The widget host's commands (src/engine/adapter/native.ts in the app; fakes in tests). */
export interface WidgetHostApi {
  show(bounds: WidgetBounds): Promise<void>;
  hide(): Promise<void>;
  mount(widgets: WidgetMountEntry[]): Promise<string[]>;
  push(id: string, data: unknown): Promise<void>;
  register(id: string, version: number, html: string): Promise<string>;
  onAction(handler: (action: WidgetAction) => void): () => void;
}

function sameBounds(a: WidgetBounds | null, b: WidgetBounds | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Keeps the widgets webview where its tile is, and out of the way of overlays. Calls are
 * serialized, so a fast cover/uncover can't leave it in the wrong state.
 */
export class WidgetHost {
  private bounds: WidgetBounds | null = null;
  private covered = false;
  /** What the webview is doing now: shown at these bounds, or hidden (null). */
  private shownAt: WidgetBounds | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly api: WidgetHostApi;

  constructor(api: WidgetHostApi) {
    this.api = api;
  }

  /** The tile's bounds (logical px in the window), or null when no tile is on screen. */
  place(bounds: WidgetBounds | null): Promise<void> {
    this.bounds = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
    return this.sync();
  }

  /** True while a menu, modal, toast or notification covers Home. */
  setCovered(covered: boolean): Promise<void> {
    this.covered = covered;
    return this.sync();
  }

  register(id: string, version: number, html: string): Promise<string> {
    return this.api.register(id, version, html);
  }

  /** Mounts widgets once the webview is up; resolves with the IDs the host page mounted. */
  async mount(widgets: WidgetMountEntry[]): Promise<string[]> {
    await this.queue;
    return this.api.mount(widgets);
  }

  push(id: string, data: unknown): Promise<void> {
    return this.api.push(id, data);
  }

  onAction(handler: (action: WidgetAction) => void): () => void {
    return this.api.onAction(handler);
  }

  private sync(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const want = this.covered ? null : this.bounds;
        if (want === null) {
          if (this.shownAt !== null) {
            this.shownAt = null;
            await this.api.hide();
          }
        } else if (!sameBounds(want, this.shownAt)) {
          this.shownAt = want;
          await this.api.show(want);
        }
      })
      .catch((error: unknown) => {
        this.shownAt = null;
        console.error("widget host", error);
      });
    return this.queue;
  }
}
