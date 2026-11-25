import { describe, expect, it } from "vitest";
import { contrast } from "./contrast.ts";
import { CONTRAST_PAIRS, DEFAULT_THEME, RLX_THEME, THEMES, type ThemeTokens } from "./themes.ts";
import tokensRaw from "./tokens.css?raw";

// Normalise line endings: a Windows checkout may turn LF into CRLF.
const tokensCss = tokensRaw.replace(/\r\n/g, "\n");

describe("contrast", () => {
  it("follows the WCAG formula", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBe(1);
    // The figures rlx's theme documents for labels on its blue.
    expect(contrast("#08090B", "#2F74F0")).toBeCloseTo(4.63, 2);
    expect(contrast("#FFFFFF", "#2F74F0")).toBeCloseTo(4.31, 2);
  });
});

describe("rlx theme", () => {
  it("is the default and equals RLX_THEME in rlx's TUI", () => {
    expect(DEFAULT_THEME).toBe("rlx");
    expect(RLX_THEME.dark).toBe(true);
    expect(RLX_THEME.tokens).toEqual({
      primary: "#2F74F0",
      accent: "#14B8A6",
      secondary: "#E8FF3A",
      warning: "#FF9F1C",
      error: "#FF5A5F",
      success: "#2BF07A",
      foreground: "#F1F2F4",
      background: "#08090B",
      surface: "#121317",
      panel: "#1A1B20",
      "on-primary": "#08090B",
      mark: "#2F74F0",
    } satisfies ThemeTokens);
  });
});

describe.each(THEMES.map((theme) => [theme.name, theme] as const))("theme %s", (_name, theme) => {
  it.each(CONTRAST_PAIRS.map((pair) => [`${pair.fg} on ${pair.bg} (${pair.use})`, pair] as const))(
    "%s meets its contrast minimum",
    (_label, pair) => {
      const ratio = contrast(theme.tokens[pair.fg], theme.tokens[pair.bg]);
      expect(ratio, `${ratio.toFixed(2)}:1 < ${pair.min}:1`).toBeGreaterThanOrEqual(pair.min);
    },
  );

  it("is declared in tokens.css with the same values", () => {
    const selector = theme.name === DEFAULT_THEME ? `:root,\n[data-theme="${theme.name}"]` : `[data-theme="${theme.name}"]`;
    const start = tokensCss.indexOf(`${selector} {`);
    expect(start, `no ${selector} block in tokens.css`).toBeGreaterThanOrEqual(0);
    const block = tokensCss.slice(start, tokensCss.indexOf("}", start));
    const declared = Object.fromEntries(
      [...block.matchAll(/--rlx-([a-z-]+):\s*(#[0-9A-Fa-f]{6});/g)].map((m) => [m[1], m[2]]),
    );
    expect(declared).toEqual(theme.tokens);
  });
});
