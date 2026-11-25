import { describe, expect, it } from "vitest";
import appCss from "../App.css?raw";
import { lintCalm, lintInlineStyles } from "./calmLint.ts";
import bad from "./fixtures/calm-bad.css?raw";
import good from "./fixtures/calm-good.css?raw";
import tokensCss from "./tokens.css?raw";

const tsxSources = import.meta.glob<string>(["/src/**/*.tsx"], { query: "?raw", import: "default", eager: true });

describe("calm lint", () => {
  it("fails on every accent-bar and raw-value pattern, however the CSS is laid out (reviewer cases a-h, F5)", () => {
    const rules = lintCalm(bad, "src/theme/fixtures/calm-bad.css").map((v) => `${v.line}:${v.rule}`);
    expect(rules).toEqual([
      // a. a one-line rule with a side bar and a named colour
      "2:raw-color",
      "2:side-accent",
      // b. two declarations on one line: a 2 px border, and a hex colour
      "3:border-width",
      "3:raw-color",
      // c. a value on the next line
      "5:side-accent",
      // d. redefining a token locally
      "8:token-override",
      // e. an inset bar through a custom property, and a shadow that isn't a token
      "9:shadow",
      "9:shadow",
      // f. an outer, hard-edged shadow bar
      "10:shadow",
      // g. a side-only border width
      "11:side-accent",
      // h. full named-colour list
      "12:raw-color",
      "12:raw-color",
      // F5: a coloured border, a pseudo-element stripe, a gradient bar, an underline accent
      "13:border-color",
      "14:pseudo-bar",
      "15:gradient",
      "16:underline",
      "17:border-color",
      // off-scale type, radius and spacing; a non-token outline
      "18:font-size",
      "18:radius",
      "18:spacing",
      "19:outline",
    ]);
  });

  it("passes calm CSS that uses the tokens, including one-line rules", () => {
    expect(lintCalm(good, "src/theme/fixtures/calm-good.css")).toEqual([]);
  });

  it("allows raw values only in the token file", () => {
    expect(lintCalm(tokensCss, "src/theme/tokens.css")).toEqual([]);
    expect(lintCalm(".x { color: #123456 }", "src/App.css").map((v) => v.rule)).toEqual(["raw-color"]);
  });

  it("finds nothing in the app's stylesheet", () => {
    expect(lintCalm(appCss, "src/App.css").map((v) => `${v.line}:${v.rule}: ${v.text}`)).toEqual([]);
  });

  it("keeps colours, borders, shadows and spacing out of TSX inline styles", () => {
    expect(lintInlineStyles(`<div style={{ borderLeft: "3px solid red" }} />`, "x.tsx").map((v) => v.rule)).toEqual(["inline-style"]);
    expect(lintInlineStyles(`<div style={{ width: sidebar }} />`, "x.tsx")).toEqual([]);
    const offenders = Object.entries(tsxSources).flatMap(([path, text]) => lintInlineStyles(text, path).map((v) => v.text));
    expect(offenders).toEqual([]);
  });
});
