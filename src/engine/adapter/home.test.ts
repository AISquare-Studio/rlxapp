import { describe, expect, it } from "vitest";
import { SANDBOX_HOME, engineHome, homeProblem } from "./home.ts";

describe("engine home", () => {
  it("defaults to the sandbox", () => {
    expect(SANDBOX_HOME).toBe("~/.rlx-sandbox");
    expect(engineHome(undefined)).toBe(SANDBOX_HOME);
    expect(engineHome("  ")).toBe(SANDBOX_HOME);
  });

  it("uses a configured sandbox, and refuses the real rlx home however it's spelled", () => {
    expect(engineHome("~/rlx-dev")).toBe("~/rlx-dev");
    const real = ["~/.", "aisquare"].join("");
    for (const home of [real, `${real}/`, "/Users/sam/.aisquare", "C:\\Users\\sam\\.aisquare"]) {
      expect(homeProblem(home)).toMatch(/real rlx home/);
      expect(engineHome(home)).toBe(SANDBOX_HOME);
    }
    expect(homeProblem("relative/path")).toMatch(/absolute/);
  });
});
