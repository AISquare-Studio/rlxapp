// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMIT_BYTES, evaluate, findInstallers } from "./installer-sizes.mjs";

const SCRIPT = join(import.meta.dirname, "installer-sizes.mjs");
const MB = 1_000_000;
const dirs = [];

/** A fake bundle dir: { "dmg/rlx.dmg": bytes, ... }. Files are sparse where the OS allows. */
function fakeBundle(files) {
  const dir = mkdtempSync(join(tmpdir(), "rlx-sizes-"));
  dirs.push(dir);
  for (const [path, size] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
    truncateSync(file, size);
  }
  return dir;
}

function runGate(dir) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installer size gate", () => {
  it("fails a 26 MB installer and passes a 1 MB one", () => {
    const rows = evaluate([
      { name: "rlx_0.1.0_aarch64.dmg", size: 26 * MB },
      { name: "rlx_0.1.0_x64_en-US.msi", size: 1 * MB },
    ]);
    expect(rows.map((r) => r.verdict)).toEqual(["OVER", "OK"]);
  });

  it("passes an installer of exactly 25,000,000 bytes", () => {
    expect(LIMIT_BYTES).toBe(25_000_000);
    expect(evaluate([{ name: "rlxapp_0.1.0_amd64.deb", size: LIMIT_BYTES }])[0]?.verdict).toBe("OK");
    expect(evaluate([{ name: "rlxapp_0.1.0_amd64.deb", size: LIMIT_BYTES + 1 }])[0]?.verdict).toBe("OVER");
  });

  it("reports the AppImage but never gates it", () => {
    const [row] = evaluate([{ name: "rlxapp_0.1.0_amd64.AppImage", size: 80 * MB }]);
    expect(row).toMatchObject({ gated: false, verdict: "report only" });
  });

  it("exits 1 and prints every size when a 26 MB installer is present", () => {
    const dir = fakeBundle({
      "deb/rlxapp_0.1.0_amd64.deb": 26 * MB,
      "rpm/rlxapp-0.1.0-1.x86_64.rpm": 1 * MB,
      "appimage/rlxapp_0.1.0_amd64.AppImage": 80 * MB,
    });
    expect(findInstallers(dir).map((i) => i.name)).toEqual([
      "rlxapp-0.1.0-1.x86_64.rpm",
      "rlxapp_0.1.0_amd64.AppImage",
      "rlxapp_0.1.0_amd64.deb",
    ]);
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("| rlxapp_0.1.0_amd64.deb | 26.00 MB | 26000000 | OVER |");
    expect(result.stdout).toContain("| rlxapp-0.1.0-1.x86_64.rpm | 1.00 MB | 1000000 | OK |");
    expect(result.stdout).toContain("| rlxapp_0.1.0_amd64.AppImage | 80.00 MB | 80000000 | report only |");
    expect(result.stderr).toContain("rlxapp_0.1.0_amd64.deb is 26000000 bytes");
  });

  it("exits 0 when every gated installer is within budget, even beside a large AppImage", () => {
    const dir = fakeBundle({
      "dmg/rlx_0.1.0_aarch64.dmg": 1 * MB,
      "nsis/rlx_0.1.0_x64-setup.exe": 1 * MB,
      "appimage/rlxapp_0.1.0_amd64.AppImage": 80 * MB,
    });
    const result = runGate(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| rlx_0.1.0_aarch64.dmg | 1.00 MB | 1000000 | OK |");
  });

  it("exits 1 when there are no installers", () => {
    const result = runGate(fakeBundle({ "macos/README": 10 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no installers");
  });
});
