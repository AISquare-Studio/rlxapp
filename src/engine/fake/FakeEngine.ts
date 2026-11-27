/**
 * FakeEngine: the Engine interface on scripted, mock data. It drives the UI shell and its tests
 * until RlxEngine (rlx 0.10.3's rlxd) exists. Nothing here touches the network, Claude Code,
 * rlx or a connector.
 */
import { GMAIL as GMAIL_ID, GOOGLE_CALENDAR, GOOGLE_DRIVE, LINEAR, SLACK, connectorLabel, type ConnectorId } from "../../core/connectors.ts";
import type { ClaudeMock, DemoControls } from "../demo.ts";
import type {
  BoardTask,
  Connector,
  DeveloperEngine,
  Engine,
  EngineInfo,
  EngineStatus,
  FleetAgent,
  RunEvent,
  RunFilter,
  RunId,
  RunRequest,
  RunState,
  RunSummary,
  HostSettings,
  Seq,
  SignInStep,
  Unsubscribe,
} from "../types.ts";
import {
  BOARD,
  CHAT_REPLIES,
  CONNECTORS,
  FLEET,
  GMAIL,
  LINEAR_FEED,
  MOCK_ACCOUNT,
  OPEN_PRS,
  PANE_LINES,
  SLACK_DIGEST,
  TASK_SCRIPTS,
  AGENT_WIDGET_HTML,
  BRIEFING,
} from "./data.ts";
import { wantsBriefing } from "../runs.ts";

export type { ClaudeMock } from "../demo.ts";

interface RunRecord {
  req: RunRequest;
  state: RunState;
  title: string;
  startedAt: number;
  events: Seq<RunEvent>[];
  listeners: Set<(event: Seq<RunEvent>) => void>;
  timers: ReturnType<typeof setTimeout>[];
  /** Steps still to stream, for tasks. */
  pending: string[];
  /** Milliseconds between this run's steps, if not the engine's. */
  stepMs?: number;
  /**
   * Finishes on its own timer (agent runs, chat turns, widget refreshes…). The task scheduler
   * must never pick it up: it would finish it with a scripted task's output instead.
   */
  instant?: boolean;
  failureReason?: string;
}

export interface FakeEngineOptions {
  /** Milliseconds between scripted steps of a task. */
  stepMs?: number;
  /** Seed the task list with one run in each state. */
  seed?: boolean;
  now?: () => number;
}

const MAX_RUNNING_TASKS = 2;

/** rlx's defaults: the service starts at login, and its tray icon is the colour '\'. */
export const DEFAULT_HOST_SETTINGS: HostSettings = { startAtLogin: true, serviceTrayIcon: "color" };

export class FakeEngine implements Engine, DeveloperEngine, DemoControls {
  private readonly records = new Map<RunId, RunRecord>();
  private readonly changeListeners = new Set<() => void>();
  private claude: ClaudeMock = "signed-in";
  private readonly stepMs: number;
  private readonly now: () => number;
  private counter = 0;
  /** New Slack messages the next fetch finds; the first fetch finds 3. */
  private slackNew = 3;
  /** Host settings, per host; this mock serves one host. */
  private readonly hosts = new Map<string, HostSettings>([["local", { ...DEFAULT_HOST_SETTINGS }]]);
  private readonly host = "local";
  private readonly hostListeners = new Set<(settings: HostSettings) => void>();

  constructor(options: FakeEngineOptions = {}) {
    this.stepMs = options.stepMs ?? 1400;
    this.now = options.now ?? Date.now;
    if (options.seed ?? true) this.seed();
  }

  // ---- DemoControls ----------------------------------------------------------------------

  /** Switches the mock Claude Code state shown during onboarding. */
  setClaudeState(state: ClaudeMock): void {
    this.claude = state;
  }

  /** Makes the next Slack fetch find `count` new messages, so it takes a model turn. */
  simulateNewSlack(count = 3): void {
    this.slackNew = count;
  }

  claudeState(): ClaudeMock {
    return this.claude;
  }

  // ---- Engine --------------------------------------------------------------------------

  hello(): Promise<EngineInfo> {
    return Promise.resolve({ protocolVersion: 1, engineVersion: "fake-0.10.3", capabilities: ["fake"] });
  }

  status(): Promise<EngineStatus> {
    if (this.claude === "not-installed") return Promise.resolve({ kind: "not-installed" });
    if (this.claude === "signed-out") return Promise.resolve({ kind: "signed-out" });
    return Promise.resolve({ kind: "ready", account: MOCK_ACCOUNT, plan: "Max" });
  }

  /** A mock install: not installed → signed out, with progress. */
  install(onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve) => {
      let pct = 0;
      const tick = () => {
        pct = Math.min(100, pct + 20);
        onProgress(pct);
        if (pct >= 100) {
          this.claude = "signed-out";
          resolve();
        } else {
          setTimeout(tick, this.stepMs / 4);
        }
      };
      setTimeout(tick, this.stepMs / 4);
    });
  }

  signIn(onStep: (step: SignInStep) => void): Promise<void> {
    return new Promise((resolve) => {
      onStep({ kind: "open-url", url: "https://claude.ai/oauth/authorize?mock=1" });
      setTimeout(() => {
        onStep({ kind: "waiting" });
        setTimeout(() => {
          this.claude = "signed-in";
          onStep({ kind: "signed-in", account: MOCK_ACCOUNT });
          resolve();
        }, this.stepMs);
      }, this.stepMs / 2);
    });
  }

  connectors(): Promise<Connector[]> {
    return Promise.resolve(structuredClone(CONNECTORS));
  }

  run(req: RunRequest): Promise<RunId> {
    if (this.records.has(req.id)) return Promise.reject(new Error(`run_exists: ${req.id}`));
    const record = this.create(req, "queued", this.now());
    if (req.kind === "task" && req.agentId === undefined) {
      // The owner's task: the mock model follows a script for its prompt.
      record.pending = [...(TASK_SCRIPTS[record.title] ?? TASK_SCRIPTS.default ?? [])];
      this.schedule();
    } else {
      record.instant = true;
      // An agent's run takes a moment, so its "running" state shows; the briefing a little longer.
      const delay = req.jobId === undefined ? 300 : wantsBriefing(req.outputSchema) ? 2 * this.stepMs : this.stepMs;
      this.later(record, delay, () => this.finishInstant(record));
    }
    this.changed();
    return Promise.resolve(req.id);
  }

  runs(filter: RunFilter = {}): Promise<RunSummary[]> {
    const all = [...this.records.entries()]
      .filter(([, r]) => filter.jobId === undefined || r.req.jobId === filter.jobId)
      .map(([id, r]) => ({
        id,
        kind: r.req.kind,
        state: r.state,
        title: r.title,
        startedAt: r.startedAt,
        lastSeq: r.events.length,
        failureReason: r.failureReason,
        jobId: r.req.jobId,
        agentId: r.req.agentId,
        loud: r.req.loud,
        account: r.req.account,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
    return Promise.resolve(filter.limit === undefined ? all : all.slice(0, filter.limit));
  }

  attach(run: RunId, fromSeq: number, onEvent: (event: Seq<RunEvent>) => void): Unsubscribe {
    const record = this.records.get(run);
    if (!record) return () => {};
    for (const event of record.events) {
      if (event.seq >= fromSeq) onEvent(event);
    }
    record.listeners.add(onEvent);
    return () => record.listeners.delete(onEvent);
  }

  resume(run: RunId, reply?: string): Promise<void> {
    const record = this.records.get(run);
    if (!record) return Promise.reject(new Error(`unknown run ${run}`));
    if (record.state !== "needs-you" && record.state !== "failed") {
      return Promise.reject(new Error("run_alive"));
    }
    record.state = "queued";
    record.failureReason = undefined;
    if (reply) this.emit(record, { type: "text", delta: `Got it: “${reply}”. Continuing.` });
    record.pending = ["Picking up where I left off.", "Applying your answer.", "Done."];
    this.schedule();
    this.changed();
    return Promise.resolve();
  }

  cancel(run: RunId): Promise<void> {
    const record = this.records.get(run);
    if (!record) return Promise.resolve();
    if (record.state === "done" || record.state === "failed") return Promise.resolve();
    this.clearTimers(record);
    record.pending = [];
    record.state = "failed";
    record.failureReason = "cancelled";
    this.emit(record, { type: "finished", status: "cancelled", reason: "cancelled" });
    this.schedule();
    this.changed();
    return Promise.resolve();
  }

  onRunsChanged(listener: () => void): Unsubscribe {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  hostSettings(): Promise<HostSettings> {
    return Promise.resolve({ ...(this.hosts.get(this.host) ?? DEFAULT_HOST_SETTINGS) });
  }

  updateHostSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
    const next = { ...(this.hosts.get(this.host) ?? DEFAULT_HOST_SETTINGS), ...patch };
    this.hosts.set(this.host, next);
    for (const listener of this.hostListeners) listener({ ...next });
    return Promise.resolve({ ...next });
  }

  onHostSettingsChanged(listener: (settings: HostSettings) => void): Unsubscribe {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  // ---- DeveloperEngine -----------------------------------------------------------------

  fleet(): Promise<FleetAgent[]> {
    return Promise.resolve(structuredClone(FLEET));
  }

  board(): Promise<BoardTask[]> {
    return Promise.resolve(structuredClone(BOARD));
  }

  watchPane(agentId: string, onFrame: (text: string) => void): Unsubscribe {
    const lines = PANE_LINES[agentId] ?? PANE_LINES.default ?? [];
    let shown = 1;
    onFrame(lines.slice(0, shown).join("\n"));
    const timer = setInterval(() => {
      if (shown < lines.length) {
        shown += 1;
        onFrame(lines.slice(0, shown).join("\n"));
      }
    }, this.stepMs);
    return () => clearInterval(timer);
  }

  openInTerminal(): Promise<void> {
    return Promise.resolve();
  }

  // ---- internals -----------------------------------------------------------------------

  private create(req: RunRequest, state: RunState, startedAt: number): RunRecord {
    const record: RunRecord = {
      req,
      state,
      title: req.prompt.split("\n")[0]?.trim() || req.kind,
      startedAt,
      events: [],
      listeners: new Set(),
      timers: [],
      pending: [],
    };
    this.records.set(req.id, record);
    return record;
  }

  private emit(record: RunRecord, event: RunEvent): void {
    const seq: Seq<RunEvent> = { seq: record.events.length + 1, event };
    record.events.push(seq);
    for (const listener of record.listeners) listener(seq);
  }

  private later(record: RunRecord, ms: number, fn: () => void): void {
    record.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(record: RunRecord): void {
    for (const timer of record.timers) clearTimeout(timer);
    record.timers = [];
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  private mountedConnectors(record: RunRecord): [ConnectorId, "connected"][] {
    return record.req.mount.kind === "connectors"
      ? record.req.mount.connectors.map((c) => [c, "connected"] as [string, "connected"])
      : [];
  }

  /** Starts queued tasks while fewer than two run. */
  private schedule(): void {
    const tasks = [...this.records.values()].filter((r) => r.req.kind === "task" && !r.instant);
    let running = tasks.filter((r) => r.state === "running").length;
    for (const record of tasks.sort((a, b) => a.startedAt - b.startedAt)) {
      if (running >= MAX_RUNNING_TASKS) break;
      if (record.state !== "queued") continue;
      record.state = "running";
      running += 1;
      if (!record.events.some((e) => e.event.type === "started")) {
        this.emit(record, { type: "started", connectors: this.mountedConnectors(record) });
      }
      this.later(record, record.stepMs ?? this.stepMs, () => this.step(record));
    }
    this.changed();
  }

  private step(record: RunRecord): void {
    if (record.state !== "running") return;
    const next = record.pending.shift();
    if (next === undefined) {
      record.state = "done";
      const output = record.req.agentId !== undefined
        ? { outcome: "Posted this week's pipeline notes", modelTurn: true }
        : { status: "done", summary: record.title };
      this.emit(record, { type: "finished", status: "done", output });
      this.schedule();
      return;
    }
    this.emit(record, { type: "text", delta: next });
    this.later(record, record.stepMs ?? this.stepMs, () => this.step(record));
  }

  private finishInstant(record: RunRecord): void {
    record.state = "running";
    this.emit(record, { type: "started", connectors: this.mountedConnectors(record) });
    const connector = record.req.mount.kind === "connectors" ? (record.req.mount.connectors[0] ?? "") : "";
    let output: unknown = null;
    if (record.req.kind === "widget_author") {
      output = {
        manifest: { schemaVersion: 1, id: `agent-${record.req.id.slice(0, 6)}`, version: 1, title: record.title },
        html: AGENT_WIDGET_HTML,
      };
    } else if (record.req.jobId !== undefined) {
      // An agent's job fired: the mock does what that agent does.
      const id = record.req.agentId ?? "";
      if (wantsBriefing(record.req.outputSchema)) {
        for (const line of ["Read Meetings, Gmail and Slack outcomes.", "Merged 2 duplicates.", "Re-prioritized 9 items."]) {
          this.emit(record, { type: "text", delta: line });
        }
        output = BRIEFING;
      } else if (id === "slack-agent" && this.slackNew > 0) {
        output = { outcome: `Claude reviewed ${this.slackNew} new`, modelTurn: true };
        this.slackNew = 0;
      } else {
        output = { outcome: "Fetched, nothing new, no Claude usage", modelTurn: false };
      }
    } else if (connector === SLACK) {
      // Each interval fetches with no model turn; Claude reviews only what's new.
      output = { ...SLACK_DIGEST, reviewed: this.slackNew };
      this.slackNew = 0;
    } else if (connector === GMAIL_ID) {
      output = GMAIL;
    } else if (connector === LINEAR) {
      output = LINEAR_FEED;
    } else if (record.req.kind === "widget_refresh" && /pull request/i.test(record.req.prompt)) {
      output = OPEN_PRS;
    } else if (record.req.kind === "parse_instruction") {
      output = parseInstruction(record.req.prompt);
    } else if (record.req.kind === "check") {
      output = { verdict: "match", reason: "The body matches the approval." };
    } else {
      const reply = CHAT_REPLIES[this.counter % CHAT_REPLIES.length] ?? "";
      this.counter += 1;
      for (const word of reply.split(" ")) this.emit(record, { type: "text", delta: `${word} ` });
      output = { reply };
    }
    record.state = "done";
    this.emit(record, { type: "finished", status: "done", output });
    this.changed();
  }

  private seed(): void {
    const minute = 60_000;
    const base = this.now();
    const mk = (title: string, state: RunState, agoMin: number, extra: Partial<RunRequest> = {}) => {
      const req: RunRequest = {
        id: `seed-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`,
        kind: "task",
        prompt: title,
        mount: { kind: "connectors", connectors: [SLACK] },
        needsConnectors: [],
        persist: true,
        ...extra,
      };
      const record = this.create(req, state, base - agoMin * minute);
      return record;
    };
    const done = mk("Summarize the #launch thread", "done", 50);
    this.emit(done, { type: "started", connectors: this.mountedConnectors(done) });
    for (const line of ["Read 48 messages in #launch.", "Grouped them into 5 decisions and 3 open questions.", "Done: summary posted to your notes."]) {
      this.emit(done, { type: "text", delta: line });
    }
    this.emit(done, { type: "finished", status: "done", output: { status: "done" } });

    const failed = mk("Update CRM notes from yesterday's calls", "failed", 35);
    this.emit(failed, { type: "started", connectors: this.mountedConnectors(failed) });
    this.emit(failed, { type: "text", delta: "Looking for yesterday's call notes…" });
    this.emit(failed, { type: "finished", status: "failed", reason: "The CRM connector isn't connected." });
    failed.failureReason = "The CRM connector isn't connected.";

    const needs = mk("Triage my inbox and draft replies", "needs-you", 20);
    this.emit(needs, { type: "started", connectors: this.mountedConnectors(needs) });
    this.emit(needs, { type: "text", delta: "Sorted 21 emails: 2 need replies." });
    this.emit(needs, { type: "question", text: "Tom asks about clause 7. Should I accept it as written, or ask for a 30-day notice period?" });

    // The GTM agent is mid-run when the app opens, so the Agents section shows one running.
    const gtm = mk("GTM agent", "queued", 6, {
      prompt: "GTM agent\nReviews the pipeline and drafts the weekly go-to-market notes.",
      jobId: "job-gtm-agent",
      agentId: "gtm-agent",
      loud: false,
      mount: { kind: "connectors", connectors: [SLACK, GMAIL_ID] },
      persist: false,
    });
    gtm.stepMs = this.stepMs * 8;
    gtm.pending = [
      "Reading #sales and #gtm since Friday.",
      "Matching 6 open deals to their email threads.",
      "Northwind: intro call today; Aiko's intro is unanswered.",
      "Two deals have no reply in 5 days.",
      "Drafting this week's pipeline notes.",
      "Checking the notes against last week's.",
      "Done.",
    ];

    const running = mk("Weekly status report", "queued", 5);
    running.pending = [...(TASK_SCRIPTS["Weekly status report"] ?? [])];
    mk("Prepare the Q4 deck outline", "queued", 2).pending = [...(TASK_SCRIPTS.default ?? [])];
    mk("Find a slot for the Northwind call", "queued", 1).pending = [...(TASK_SCRIPTS.default ?? [])];
    this.schedule();
  }
}

/**
 * The mock of the manager's ParseInstruction run: it proposes an agent from what the owner typed.
 * Connectors are suggestions the owner edits; nothing is hard-wired.
 */
export function parseInstruction(text: string): {
  role?: "briefing";
  purpose: string;
  name: string;
  connectors: ConnectorId[];
  schedule: { kind: "weekdays" | "daily" | "interval"; at?: string; everyMin?: number };
  mode: "silent" | "loud";
  outputs: ("channel" | "widget" | "dashboard")[];
  reply: string;
} {
  const lower = text.toLowerCase();
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(lower);
  let at = "09:00";
  if (time) {
    let hour = Number(time[1]);
    if (time[3] === "pm" && hour < 12) hour += 12;
    at = `${String(hour).padStart(2, "0")}:${time[2] ?? "00"}`;
  }
  const weekdays = /weekday|every day of the week|mon(day)?.{0,4}fri/.test(lower);
  if (/start of (the )?day|briefing|morning/.test(lower)) {
    return {
      role: "briefing",
      purpose: "Gathers your agents' latest outcomes, removes duplicates, and re-prioritizes them into one briefing.",
      name: "Start of day",
      connectors: [GOOGLE_CALENDAR, GOOGLE_DRIVE, GMAIL_ID, SLACK],
      schedule: { kind: weekdays || !/daily|every day/.test(lower) ? "weekdays" : "daily", at },
      mode: "loud",
      outputs: ["channel", "dashboard"],
      reply: "Here's what I'd set up. Change anything, then confirm.",
    };
  }
  const connectors = [SLACK, GMAIL_ID, LINEAR, GOOGLE_CALENDAR].filter((c) => lower.includes(connectorLabel(c).toLowerCase().split(" ")[0] ?? ""));
  return {
    purpose: text.trim(),
    name: "New agent",
    connectors: connectors.length ? connectors : [SLACK],
    schedule: { kind: weekdays ? "weekdays" : "daily", at },
    mode: "silent",
    outputs: ["channel"],
    reply: "Here's a first version. Change anything, then confirm.",
  };
}
