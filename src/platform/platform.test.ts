import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { browserPlatform, detectPlatform, nativePlatform } from "./index.ts";

// The Tauri runtime sets `globalThis.isTauri`; mockIPC only fakes the IPC bridge.
function enterTauri() {
  Object.assign(globalThis, { isTauri: true });
}

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "isTauri");
});

describe("detectPlatform", () => {
  it("falls back to the browser mock when Tauri is absent", async () => {
    const platform = detectPlatform();

    expect(platform).toBe(browserPlatform);
    await expect(platform.appInfo()).resolves.toEqual({
      name: "rlx",
      version: __APP_VERSION__,
      os: "browser",
      arch: "n/a",
      runtime: "browser",
      measuring: false,
    });
    await expect(platform.reportFirstPaint(1, "fcp")).resolves.toBeUndefined();
  });

  it("uses the native adapter inside Tauri", () => {
    enterTauri();
    expect(detectPlatform()).toBe(nativePlatform);
  });
});

describe("nativePlatform", () => {
  it("reads app info from the `app_info` command", async () => {
    enterTauri();
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "app_info") {
        return { name: "rlx", version: "0.1.0", os: "linux", arch: "x86_64", measuring: true };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    await expect(nativePlatform.appInfo()).resolves.toEqual({
      name: "rlx",
      version: "0.1.0",
      os: "linux",
      arch: "x86_64",
      measuring: true,
      runtime: "native",
    });
    expect(calls).toEqual(["app_info"]);
  });

  it("sends the first-paint time with camelCase args", async () => {
    enterTauri();
    let received: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "report_first_paint") {
        received = args;
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    await nativePlatform.reportFirstPaint(1_700_000_000_123.5, "fcp");

    expect(received).toEqual({ epochMs: 1_700_000_000_123.5, source: "fcp" });
  });
});

describe("widgetSource", () => {
  it("keeps agent-made widgets off in the app while the host's policy says so, and registers nothing", async () => {
    enterTauri();
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "widgets_policy") {
        return { widgetWebview: true, builtins: "widgets", agentWidgets: "off: off on macOS until the isolation probe passes there" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    await expect(nativePlatform.widgetPolicy()).resolves.toEqual({
      widgetWebview: true,
      builtins: "widgets",
      agentWidgets: { on: false, reason: "off on macOS until the isolation probe passes there" },
    });
    await expect(nativePlatform.widgetSource("w", 1, "<p>hi</p>")).resolves.toEqual({
      off: "off on macOS until the isolation probe passes there",
    });
    expect(calls).toEqual(["widgets_policy"]);
  });

  it("renders them inline in the browser preview, which has no widget webview", async () => {
    await expect(browserPlatform.widgetSource("w", 1, "<p>hi</p>")).resolves.toEqual({ srcdoc: "<p>hi</p>" });
    await expect(browserPlatform.widgetPolicy()).resolves.toEqual({ widgetWebview: false, builtins: "main", agentWidgets: { on: true } });
  });
});
