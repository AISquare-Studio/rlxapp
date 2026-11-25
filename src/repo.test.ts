/**
 * Repository-wide rules the acceptance criteria state as greps, checked on every test run.
 */
import { describe, expect, it } from "vitest";
import appCss from "./App.css?raw";
import tokensCss from "./theme/tokens.css?raw";

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "/index.html"], { query: "?raw", import: "default", eager: true });
const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

describe("source rules", () => {
  it("defines APP_HOMEPAGE_URL exactly once, as the repository URL", () => {
    const definitions = files.flatMap(([path, text]) =>
      [...text.matchAll(/APP_HOMEPAGE_URL\s*=\s*"([^"]+)"/g)].map((m) => [path, m[1]] as const),
    );
    expect(definitions).toEqual([["/src/brand/homepage.ts", "https://github.com/AISquare-Studio/rlxapp"]]);
    const raw = files.filter(([path, text]) => path !== "/src/brand/homepage.ts" && text.includes("github.com/AISquare-Studio/rlxapp"));
    expect(raw.map(([path]) => path)).toEqual([]);
  });

  it("calls the core only from the engine adapter", () => {
    const callers = files.filter(([, text]) => text.includes("invoke(")).map(([path]) => path);
    expect(callers).toEqual(["/src/engine/adapter/native.ts"]);
  });

  it("never shows the repo name rlxapp to users", () => {
    const offenders = files.flatMap(([path, text]) =>
      text
        .split("\n")
        .filter((line) => /rlxapp/.test(line))
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter((line) => !/github\.com\/AISquare-Studio\/rlxapp/.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("respects prefers-reduced-motion and shows a focus ring on every control", () => {
    expect(tokensCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0ms !important/);
    expect(appCss).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--rlx-primary\)/);
  });
});
