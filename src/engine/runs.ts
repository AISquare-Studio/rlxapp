import type { RunState, RunSummary } from "./types.ts";

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
};

/** A briefing's source link, as it cites it. */
export interface BriefSource {
  label: string;
  connector: string;
  url: string;
}

export interface BriefItem {
  id: string;
  text: string;
  why?: string;
  sources: BriefSource[];
}

/**
 * The Start of day agent's output: the Meetings, Gmail and Slack agents' latest outcomes,
 * de-duplicated (Priya's pricing sign-off came in on Slack and Gmail; it is one item) and
 * re-prioritized.
 */
export interface Briefing {
  summary: string;
  doNow: BriefItem[];
  today: BriefItem[];
  waiting: BriefItem[];
  checklist: string[];
  promise: { text: string; due: string; meeting: string; sources: BriefSource[] };
  draft: { to: string; subject: string; body: string; connector: string; context: string };
  /** `draftTemplate` gets the owner's answer in place of `{answer}`. */
  needsContext: { question: string; to: string; subject: string; connector: string; sources: BriefSource[]; draftTemplate: string };
  /** The feeds it read, for the de-duplication count. */
  read: { meetings: number; gmail: number; slack: number; merged: number };
}

/** The output schema of a briefing agent's run: the Start of day briefing (see `Briefing`). */
export const BRIEFING_SCHEMA = { $id: "rlx.briefing.v1" } as const;

/** Whether a run request asks for the briefing schema. */
export function wantsBriefing(outputSchema: unknown): boolean {
  return typeof outputSchema === "object" && outputSchema !== null && (outputSchema as { $id?: unknown }).$id === BRIEFING_SCHEMA.$id;
}

/** A chat turn in an agent's channel: a Task for that agent that no job fired. */
export function isChatTurn(run: Pick<RunSummary, "kind" | "agentId" | "jobId">): boolean {
  return run.kind === "task" && run.agentId !== undefined && run.jobId === undefined;
}

/** A run an agent's job fired (its schedule, or Wake now). */
export function isAgentRun(run: Pick<RunSummary, "agentId" | "jobId">): run is { agentId: string; jobId: string } {
  return run.agentId !== undefined && run.jobId !== undefined;
}

/** The runs Developer › Runs lists: the owner's tasks and agents' runs, not chat, widget refreshes or checks. */
export function taskRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.kind === "task" && !isChatTurn(r));
}
