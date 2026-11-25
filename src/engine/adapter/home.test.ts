import { describe, expect, it } from "vitest";
import { SANDBOX_HOME, engineHome, homeProblem } from "./home.ts";

const real = ["~/.", "aisquare"].join("");

describe("engine home", () => {
  it("defaults to the sandbox", () => {
    expect(SANDBOX_HOME).toBe("~/.rlx-sandbox");
    expect(engineHome(undefined)).toBe(SANDBOX_HOME);
    expect(engineHome("  ")).toBe(SANDBOX_HOME);
  });

  it("refuses the real rlx home, or anything inside it, with '/.', '..' or other letter case (F3)", () => {
    for (const home of [
      real,
      `${real}/`,
      `${real}/.`,
      `${real}/./`,
      real.toUpperCase().replace("~", "~"),
      `${real}/sub`,
      `${real}/sub/deeper`,
      `~/projects/../${real.slice(2)}`,
      "/Users/sam/.aisquare",
      "/Users/sam/.AISquare/x",
      "C:\\Users\\sam\\.aisquare",
      "C:\\Users\\sam\\.aisquare\\.",
    ]) {
      expect({ home, problem: homeProblem(home), used: engineHome(home) }).toEqual({
        home,
        problem: expect.stringMatching(/real rlx home/),
        used: SANDBOX_HOME,
      });
    }
  });

  it("allows a sandbox and refuses relative paths", () => {
    expect(engineHome("~/rlx-dev")).toBe("~/rlx-dev");
    expect(engineHome("~/.aisquare-old/../rlx-dev")).toBe("~/.aisquare-old/../rlx-dev");
    expect(homeProblem("relative/path")).toMatch(/absolute/);
  });
});
