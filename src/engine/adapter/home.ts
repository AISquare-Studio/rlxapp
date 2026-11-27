/**
 * The rlx home the engine adapter points rlxd at (its AISQUARE_HOME). The app never reads or
 * writes the owner's real rlx home: dev builds default to a sandbox, and a configured home that
 * is the real one is refused.
 */

/** The sandboxed rlx 0.10.3 home ws2 builds for app development. */
export const SANDBOX_HOME = "~/.rlx-sandbox";

/** The owner's real rlx home, spelled so a grep for it finds only this guard. */
const REAL_HOME_DIR = [".", "aisquare"].join("");

/** The path's segments with `.` dropped and `..` resolved, lower-cased (APFS and NTFS ignore case). */
function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part.toLowerCase());
  }
  return out;
}

/**
 * Why `home` can't be used, or null if it can. A friendly first pass for the Settings field:
 * the core's resolve_engine_home (src-tauri/src/engine_home.rs) is the enforcement, and it also
 * resolves symlinks. This catches the real home or anything inside it, with a trailing `/.`,
 * `..` or different letter case.
 */
export function homeProblem(home: string): string | null {
  const value = home.trim();
  if (!value) return null;
  if (!/^(~|\/|[A-Za-z]:[\\/])/.test(value)) return "Use an absolute path, or one that starts with ~.";
  if (segments(value).includes(REAL_HOME_DIR)) {
    return `That's your real rlx home, or inside it. The app only uses a sandbox, such as ${SANDBOX_HOME}.`;
  }
  return null;
}

/**
 * The home to use: the configured one if it's allowed, else the sandbox. Dev builds default to
 * the sandbox; so do release builds, until the real engine (RlxEngine) replaces the FakeEngine.
 */
export function engineHome(configured: string | undefined): string {
  const value = configured?.trim() ?? "";
  return value && homeProblem(value) === null ? value : SANDBOX_HOME;
}
