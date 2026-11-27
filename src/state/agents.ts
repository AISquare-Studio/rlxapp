/**
 * Agents as a normal person makes them: a name, a schedule, connectors, silent or loud, and an
 * output (owner's brief, 2026-11-25). An agent sleeps by default; the scheduler wakes it for one
 * run, and it sleeps again after.
 */

export type AgentMode = "silent" | "loud";
export type AgentOutput = "channel" | "widget" | "dashboard";
/** What the app stores. "Running" is never stored: it comes from the engine's runs. */
export type AgentState = "asleep" | "paused";

export interface Schedule {
  /** "weekdays", "daily" or "interval". */
  kind: "weekdays" | "daily" | "interval";
  /** HH:MM for weekdays and daily. */
  at?: string;
  /** Minutes, for interval. */
  everyMin?: number;
}

export interface AgentRun {
  at: number;
  outcome: string;
  /** Whether the run took a model turn (Claude usage). */
  modelTurn: boolean;
}

export interface Agent {
  id: string;
  name: string;
  /** A short letter-mark for the avatar. */
  avatar: string;
  purpose: string;
  connectors: string[];
  schedule: Schedule;
  mode: AgentMode;
  outputs: AgentOutput[];
  state: AgentState;
  lastRun?: AgentRun;
  /** "briefing": gathers the other agents' latest outcomes into one prioritized briefing. */
  role?: "briefing";
}

/** Every connector the demo user has. Nothing is hard-wired: an agent picks from these. */
export const USER_CONNECTORS = [
  "Google Calendar",
  "Meet transcripts (Google Drive)",
  "Gmail",
  "Slack",
  "Linear",
] as const;

export const START_OF_DAY_ID = "start-of-day";

/** An avatar letter-mark no other agent uses: the first letter, else the initials ("SD"). */
export function avatarFor(name: string, others: Pick<Agent, "avatar">[]): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (words[0]?.[0] ?? "A").toUpperCase();
  const taken = new Set(others.map((a) => a.avatar));
  if (!taken.has(first)) return first;
  const initials = words
    .filter((w) => w.length > 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
  return initials.length > 1 && !taken.has(initials) ? initials : `${first}${(words[0]?.[1] ?? "").toLowerCase()}`;
}
export const MANAGER_ID = "manager";

export function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === "interval") return `Every ${schedule.everyMin ?? 15} min`;
  if (schedule.kind === "weekdays") return `Weekdays at ${schedule.at ?? "09:00"}`;
  return `Daily at ${schedule.at ?? "09:00"}`;
}

/** The next time `schedule` fires after `now`. */
export function nextWake(schedule: Schedule, now: number): number {
  if (schedule.kind === "interval") return now + (schedule.everyMin ?? 15) * 60_000;
  const [h, m] = (schedule.at ?? "09:00").split(":").map(Number);
  const next = new Date(now);
  next.setHours(h ?? 9, m ?? 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  if (schedule.kind === "weekdays") {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export function wakeLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `today ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export type AgentStatusKind = "running" | "paused" | "scheduled" | "asleep";

export interface AgentStatus {
  kind: AgentStatusKind;
  /** "Running", "Paused", "Scheduled 09:00", "Asleep". */
  label: string;
  /** When it wakes next, if it will. */
  next?: number;
}

/**
 * An agent's status: running while the engine has a live run for it; otherwise scheduled (a set
 * time of day) or asleep (an interval), with its next wake; or paused.
 */
export function agentStatus(agent: Agent, running: boolean, now: number): AgentStatus {
  if (running) return { kind: "running", label: "Running" };
  if (agent.state === "paused") return { kind: "paused", label: "Paused" };
  const next = nextWake(agent.schedule, now);
  if (agent.schedule.kind === "interval") return { kind: "asleep", label: "Asleep", next };
  return { kind: "scheduled", label: `Scheduled ${agent.schedule.at ?? "09:00"}`, next };
}

export function seedAgents(now: number): Agent[] {
  const hour = 3_600_000;
  return [
    {
      id: "slack-agent",
      name: "Slack agent",
      avatar: "S",
      purpose: "Watches your DMs, mentions and channels for things that need you.",
      connectors: ["Slack"],
      schedule: { kind: "interval", everyMin: 15 },
      mode: "silent",
      outputs: ["widget"],
      state: "asleep",
      lastRun: { at: now - 6 * 60_000, outcome: "Fetched, nothing new, no Claude usage", modelTurn: false },
    },
    {
      id: "gmail-agent",
      name: "Gmail agent",
      avatar: "G",
      purpose: "Finds email waiting on your reply and drafts answers.",
      connectors: ["Gmail"],
      schedule: { kind: "interval", everyMin: 30 },
      mode: "silent",
      outputs: ["widget", "dashboard"],
      state: "asleep",
      lastRun: { at: now - 22 * 60_000, outcome: "Claude reviewed 4 new emails; 2 need replies", modelTurn: true },
    },
    {
      id: "meetings-agent",
      name: "Meetings agent",
      avatar: "M",
      purpose: "Reads meeting notes and transcripts for what you promised or were assigned.",
      connectors: ["Google Calendar", "Meet transcripts (Google Drive)"],
      schedule: { kind: "daily", at: "08:45" },
      mode: "silent",
      outputs: ["dashboard"],
      state: "asleep",
      lastRun: { at: now - 18 * hour, outcome: "Found 2 promises in yesterday's meetings", modelTurn: true },
    },
    {
      id: "gtm-agent",
      name: "GTM agent",
      avatar: "T",
      purpose: "Reviews the pipeline and drafts the weekly go-to-market notes.",
      connectors: ["Slack", "Gmail"],
      schedule: { kind: "weekdays", at: "08:30" },
      mode: "silent",
      outputs: ["channel"],
      state: "asleep",
      lastRun: { at: now - 26 * hour, outcome: "Posted the pipeline notes", modelTurn: true },
    },
  ];
}
