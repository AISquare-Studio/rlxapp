import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import favicon from "../../public/favicon.svg?raw";
import iconMaster from "../../src-tauri/icons/master.svg?raw";
import trayDark from "../../src-tauri/icons/tray-dark.svg?raw";
import trayLight from "../../src-tauri/icons/tray-light.svg?raw";
import tray from "../../src-tauri/icons/tray.svg?raw";
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

  it.each([
    ["tray.svg (macOS template)", tray, "#000000"],
    ["tray-light.svg", trayLight, "#FFFFFF"],
    ["tray-dark.svg", trayDark, "#000000"],
  ])("is used unchanged by the tray icon %s, in one colour", (_name, svg, fill) => {
    expect(pathData(svg)).toEqual(LOGO_PATHS);
    expect(svg).toContain(`fill="${fill}"`);
    expect(svg).not.toMatch(/<rect\b/);
  });
});
