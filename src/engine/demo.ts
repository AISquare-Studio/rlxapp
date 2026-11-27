/**
 * Demo controls: switches a fake engine offers the browser preview and the tests, so a person can
 * see states a real engine only reaches on its own. A real engine has none, and the UI hides
 * every demo affordance when they are absent.
 */

/** The Claude Code states onboarding can show. */
export type ClaudeMock = "not-installed" | "signed-out" | "signed-in";

export interface DemoControls {
  /** The mock Claude Code state onboarding shows. */
  claudeState(): ClaudeMock;
  setClaudeState(state: ClaudeMock): void;
  /** Makes the next Slack fetch find `count` new messages, so it takes a model turn. */
  simulateNewSlack(count?: number): void;
}
