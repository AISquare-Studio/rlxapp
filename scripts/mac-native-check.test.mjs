// scripts/mac-native-check.sh must never replace or drive a running rlx. These run the
// script with fake lsappinfo/pgrep on PATH and a temporary install folder, so they never
// depend on what is really running and never touch /Applications. macOS only.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "mac-native-check.sh");

describe.skipIf(process.platform !== "darwin")("mac-native-check.sh: a running rlx", () => {
  let work;
  let installDir;
  let marker;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "rlx-mac-check-"));
    const bin = join(work, "bin");
    mkdirSync(bin);
    // Fakes: "running" when FAKE_RLX_RUNNING=1.
    writeFileSync(join(bin, "lsappinfo"), '#!/bin/sh\n[ "$FAKE_RLX_RUNNING" = 1 ] && echo \'ASN:0x0-0x1-"rlx":\'\nexit 0\n');
    writeFileSync(
      join(bin, "pgrep"),
      '#!/bin/sh\nif [ "$FAKE_RLX_RUNNING" = 1 ]; then echo "4242 /Applications/rlx.app/Contents/MacOS/rlxapp"; exit 0; fi\nexit 1\n',
    );
    chmodSync(join(bin, "lsappinfo"), 0o755);
    chmodSync(join(bin, "pgrep"), 0o755);
    installDir = join(work, "Applications");
    mkdirSync(join(installDir, "rlx.app"), { recursive: true });
    marker = join(installDir, "rlx.app", "owner-copy");
    writeFileSync(marker, "the owner's running app");
  });

  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const run = (args, running) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        RLX_INSTALL_DIR: installDir,
        FAKE_RLX_RUNNING: running ? "1" : "0",
      },
    });

  it("refuses --install while rlx runs, before touching the install folder", () => {
    for (const args of [["--install", "--no-build", "--dry-run"], ["--install", "--no-build"], ["--install"]]) {
      const result = run(args, true);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("rlx is running");
      expect(result.stderr).toContain("never replaces");
      expect(existsSync(marker)).toBe(true);
    }
  });

  it("refuses a plain run too: it would launch next to the running app", () => {
    const result = run(["--no-build", "--no-probe"], true);
    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(true);
  });

  it("plans the install in a dry run when nothing runs, and changes nothing", () => {
    const result = run(["--install", "--no-build", "--dry-run"], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no rlx is running");
    expect(result.stdout).toContain(`would replace ${installDir}/rlx.app`);
    expect(existsSync(marker)).toBe(true);
  });
});
