import type { RunState, RunSummary } from "./types.ts";

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
};

/** Chat messages are Task runs whose prompt starts with this; run lists leave them out. */
export const CHAT_PREFIX = "chat: ";

/** An agent's scheduled run: a Task whose prompt starts with this and the agent's id. */
export const AGENT_PREFIX = "agent:";

/** In an agent run's prompt, marks the briefing agent that reads the other agents' outcomes. */
export const BRIEFING_ROLE = "role: briefing";

/** The runs the Tasks screen lists: the owner's tasks, not chat, widget refreshes or checks. */
export function taskRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.kind === "task" && !r.title.startsWith(CHAT_PREFIX.trim()));
}
