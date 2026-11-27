import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import favicon from "../../public/favicon.svg?raw";
import iconMaster from "../../src-tauri/icons/master.svg?raw";
import logo from "../assets/rlx-logo.svg?raw";
import { RLX_MARK_PATHS } from "./mark.ts";
import { RlxMark } from "./RlxMark.tsx";
import { Splash } from "./Splash.tsx";

function pathData(svg: string): string[] {
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1] ?? "");
}

const LOGO_PATHS = pathData(logo);

describe("rlx logo", () => {
  it("is rlx's r\\x mark with its font attribution intact", () => {
    expect(logo).toContain('viewBox="0 0 1606 940"');
    expect(logo).toContain('fill="#2F74F0"');
    expect(logo).toContain("SIL Open Font License, Version 1.1");
    expect(LOGO_PATHS).toHaveLength(1);
    expect(LOGO_PATHS[0]).toMatch(/^M0 830V280H98/);
  });

  it("is used unchanged by the app icon master", () => {
    expect(pathData(iconMaster)).toEqual(LOGO_PATHS);
    expect(iconMaster).toContain('width="1024" height="1024"');
    expect(iconMaster).toContain('fill="#08090B"');
  });

  it("is used unchanged by the favicon", () => {
    expect(pathData(favicon)).toEqual(LOGO_PATHS);
  });

  it("is used unchanged by the in-app header mark", () => {
    expect(RLX_MARK_PATHS).toEqual(LOGO_PATHS);
    const { container } = render(<RlxMark />);
    const rendered = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
    expect(rendered).toEqual(LOGO_PATHS);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1606 940");
  });

  it("is used unchanged by the splash screen", () => {
    const { getByTestId } = render(<Splash />);
    const rendered = [...getByTestId("splash").querySelectorAll("path")].map((path) => path.getAttribute("d"));
    expect(rendered).toEqual(LOGO_PATHS);
  });
});

describe("onboarding brand header", () => {
  it("shows the r\\x mark in a <header>, as the native screen check (e2e/native) looks for on a fresh launch", async () => {
    const { App } = await import("../App.tsx");
    const { FakeEngine } = await import("../engine/fake/FakeEngine.ts");
    const { browserPlatform } = await import("../platform/index.ts");
    const { DEFAULT_SETTINGS } = await import("../state/model.ts");
    const view = render(<App platform={browserPlatform} engine={new FakeEngine({ seed: false })} initialSettings={{ ...DEFAULT_SETTINGS }} />);
    await view.findByRole("button", { name: "Get started" });
    const mark = document.querySelector('header svg[aria-label="rlx"]');
    expect([...(mark?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d"))).toEqual(LOGO_PATHS);
  });
});
