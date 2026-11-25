import { describe, expect, it } from "vitest";
import appCss from "../App.css?raw";
import { lintCalm } from "./calmLint.ts";
import bad from "./fixtures/calm-bad.css?raw";
import good from "./fixtures/calm-good.css?raw";
import tokensCss from "./tokens.css?raw";

describe("calm lint", () => {
  it("fails on a border-left accent, a 2 px border, inset bars, raw colours and off-scale values", () => {
    const rules = lintCalm(bad, "src/theme/fixtures/calm-bad.css").map((v) => `${v.line}:${v.rule}`);
    expect(rules).toEqual([
      "3:side-accent",
      "7:border-width",
      "11:inset-bar",
      "15:raw-color",
      "16:raw-color",
      "17:raw-color",
      "21:font-size",
      "22:radius",
      "23:spacing",
    ]);
  });

  it("passes calm CSS that uses the tokens", () => {
    expect(lintCalm(good, "src/theme/fixtures/calm-good.css")).toEqual([]);
  });

  it("allows raw colours only in the token file", () => {
    expect(lintCalm(tokensCss, "src/theme/tokens.css").filter((v) => v.rule === "raw-color")).toEqual([]);
    expect(lintCalm(".x {\n  color: #123456;\n}\n", "src/App.css").map((v) => v.rule)).toEqual(["raw-color"]);
  });

  it("finds nothing in the app's stylesheet", () => {
    expect(lintCalm(appCss, "src/App.css").map((v) => `${v.line}:${v.rule}: ${v.text}`)).toEqual([]);
  });
});
