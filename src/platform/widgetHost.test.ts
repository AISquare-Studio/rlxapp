import { describe, expect, it } from "vitest";
import { WidgetHost, parsePolicy, type WidgetBounds, type WidgetHostApi } from "./widgetHost.ts";

function fakeApi() {
  const calls: string[] = [];
  const api: WidgetHostApi = {
    show: (b: WidgetBounds) => {
      calls.push(`show ${b.x},${b.y} ${b.width}x${b.height}`);
      return Promise.resolve();
    },
    hide: () => {
      calls.push("hide");
      return Promise.resolve();
    },
    mount: (widgets) => {
      calls.push(`mount ${widgets.map((w) => w.id).join(",")}`);
      return Promise.resolve(widgets.map((w) => w.id));
    },
    push: (id) => {
      calls.push(`push ${id}`);
      return Promise.resolve();
    },
    register: (id, version) => {
      calls.push(`register ${id}@${version}`);
      return Promise.resolve(`rlxwidget://localhost/${id}/${version}/`);
    },
    onAction: () => () => {},
  };
  return { api, calls };
}

const tile = { x: 360, y: 400, width: 280, height: 200 };

describe("parsePolicy", () => {
  it("reads the core's switch: on, or off with the reason", () => {
    expect(parsePolicy({ widgetWebview: false, builtins: "main", agentWidgets: "off: off on Linux: no widget webview in v0" })).toEqual({
      widgetWebview: false,
      builtins: "main",
      agentWidgets: { on: false, reason: "off on Linux: no widget webview in v0" },
    });
    expect(parsePolicy({ widgetWebview: true, builtins: "widgets", agentWidgets: "on" }).agentWidgets).toEqual({ on: true });
  });
});

describe("WidgetHost", () => {
  it("shows the widgets webview over its tile, follows it, and hides when the tile goes", async () => {
    const { api, calls } = fakeApi();
    const host = new WidgetHost(api);
    await host.place(tile);
    await host.place(tile);
    await host.place({ ...tile, y: 300 });
    await host.place(null);
    await host.place(null);
    expect(calls).toEqual(["show 360,400 280x200", "show 360,300 280x200", "hide"]);
  });

  it("hides while a menu, modal, toast or notification covers Home, and comes back where the tile is now", async () => {
    const { api, calls } = fakeApi();
    const host = new WidgetHost(api);
    await host.place(tile);
    await host.setCovered(true);
    // The tile moves while covered: nothing shows until the cover goes.
    await host.place({ ...tile, x: 100 });
    await host.setCovered(false);
    expect(calls).toEqual(["show 360,400 280x200", "hide", "show 100,400 280x200"]);
  });

  it("never shows over an empty tile, and mounts only after the webview is placed", async () => {
    const { api, calls } = fakeApi();
    const host = new WidgetHost(api);
    await host.place({ ...tile, width: 0 });
    expect(calls).toEqual([]);
    void host.place(tile);
    await host.mount([{ id: "prs", version: 1, title: "Open pull requests" }]);
    await host.push("prs", { open: 3 });
    expect(calls).toEqual(["show 360,400 280x200", "mount prs", "push prs"]);
  });

  it("recovers after a failed show, and retries on the next placement", async () => {
    const { api, calls } = fakeApi();
    let fail = true;
    const host = new WidgetHost({
      ...api,
      show: (b) => (fail ? Promise.reject(new Error("no window")) : api.show(b)),
    });
    const error = console.error;
    console.error = () => {};
    await host.place(tile);
    console.error = error;
    fail = false;
    await host.place(tile);
    expect(calls).toEqual(["show 360,400 280x200"]);
  });
});
