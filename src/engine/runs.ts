import type { RunState, RunSummary } from "./types.ts";

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
};

/** Chat messages are Task runs whose prompt starts with this; the Tasks screen leaves them out. */
export const CHAT_PREFIX = "chat: ";

/** The runs the Tasks screen lists: the owner's tasks, not chat, widget refreshes or checks. */
export function taskRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.kind === "task" && !r.title.startsWith(CHAT_PREFIX.trim()));
}
