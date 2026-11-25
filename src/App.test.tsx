import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { browserPlatform, type AppInfo, type Platform } from "./platform/index.ts";

function fakeNative(info: Omit<AppInfo, "runtime">): Platform {
  return {
    runtime: "native",
    appInfo: () => Promise.resolve({ ...info, runtime: "native" }),
    reportFirstPaint: () => Promise.resolve(),
  };
}

describe("App placeholder", () => {
  it("shows the app name and the browser-preview label without Tauri", async () => {
    render(<App platform={browserPlatform} />);

    expect(screen.getByRole("heading", { level: 1, name: "rlxapp" })).toBeTruthy();
    const meta = await screen.findByText(`v${__APP_VERSION__} · browser preview`);
    expect(meta.dataset.testid).toBe("app-meta");
  });

  it("shows the OS and architecture reported by the native core", async () => {
    render(
      <App platform={fakeNative({ name: "rlxapp", version: "9.9.9", os: "macos", arch: "aarch64" })} />,
    );

    expect(await screen.findByText("v9.9.9 · macos (aarch64)")).toBeTruthy();
  });
});
