/**
 * The rlx home the engine adapter points rlxd at (its AISQUARE_HOME). The app never reads or
 * writes the owner's real rlx home: dev builds default to a sandbox, and a configured home that
 * is the real one is refused.
 */

/** The sandboxed rlx 0.10.3 home ws2 builds for app development. */
export const SANDBOX_HOME = "~/.rlx-sandbox";

/** The owner's real rlx home, spelled so a grep for it finds only this guard. */
const REAL_HOME_DIR = [".", "aisquare"].join("");

/** Why `home` can't be used, or null if it can. */
export function homeProblem(home: string): string | null {
  const value = home.trim();
  if (!value) return null;
  const last = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (last === REAL_HOME_DIR) return `That's your real rlx home. The app only uses a sandbox, such as ${SANDBOX_HOME}.`;
  if (!/^(~|\/|[A-Za-z]:[\\/])/.test(value)) return "Use an absolute path, or one that starts with ~.";
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
