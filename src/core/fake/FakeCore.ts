/**
 * FakeCore: the Core interface over any Engine, with the host's data in an injected HostStore.
 * It plays the app core's parts (architecture §2): the agent scheduler's follow-up (an agent's
 * run becomes channel messages, cards, drafts, the Home briefing and a notification), widgets'
 * data jobs, the send gate (Draft, Pre-approved, Auto's 10 s hold) and storage.
 *
 * It applies each change before its promise resolves; the real core applies them when the host
 * confirms, and screens follow the snapshot either way.
 */
import { BRIEFING_SCHEMA, isAgentRun, type Briefing } from "../../engine/runs.ts";
import {
  AUTO_ACCOUNT,
  type Engine,
  type HostSettings,
  type RunEvent,
  type RunId,
  type RunStatus,
  type RunSummary,
  type Seq,
  type Unsubscribe,
} from "../../engine/types.ts";
import { MANAGER_ID, START_OF_DAY_ID, avatarFor, jobIdFor, nextWake, scheduleLabel, seedAgents, wakeLabel, type Agent } from "../../state/agents.ts";
import { signOffText, type ActivityItem, type Card, type Draft, type Message, type Proposal, type SendMode, type Settings, type WidgetInstance } from "../../state/model.ts";
import type { ConnectorId } from "../connectors.ts";
import { pickDevice, type DeviceStore } from "../device.ts";
import { HOLD_MS, sendCheck, type SendResult } from "../gate.ts";
import { DEFAULT_APP_SETTINGS, MemoryHostStore, pickHost, type HostStore } from "../host.ts";
import { newRunId, nextId } from "../ids.ts";
import {
  APPROVE_CHOICE,
  DEFAULT_PENDING_MARKER,
  DISCARD_CHOICE,
  canAssume,
  newestSeq,
  type PendingAnswer,
  type PendingItem,
} from "../pending.ts";
import type { Core, CoreSnapshot, NewDraft, PriorityCard, SettingsPatch, Surface, WidgetData } from "../types.ts";
import { dataJob, linkedAgent, refreshOutcome, type DataJob } from "../widgets.ts";
import { seedData } from "./seed.ts";

export interface FakeCoreOptions {
  engine: Engine;
  /** This window's device settings; the composition root owns it. */
  device: DeviceStore;
  /** Where the host's app settings and agents persist; memory when absent. */
  host?: HostStore;
  /** Seeds the host's app settings over what it stored (tests; the preview's browser checks). */
  settings?: Partial<Settings>;
  /** The host's agents; what the host stored, else the four demo agents. */
  agents?: Agent[];
  /** Pending items besides the ones the core derives from runs and drafts (tests, demos). */
  pending?: PendingItem[];
  now?: () => number;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The owner's answer as a sentence of a reply: capitalised, and ending with a full stop. */
export function asSentence(text: string): string {
  const t = text.trim();
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

type Finished = Extract<RunEvent, { type: "finished" }>;

/** A widget's data job while anyone watches it. */
interface WidgetJob {
  widget: WidgetInstance;
  watchers: number;
  /** The job's spec as last started, to restart it when settings change it. */
  key: string;
  timer?: ReturnType<typeof setInterval>;
  /** Stops the refresh in flight, cancelling its run if it hasn't finished. */
  stop: () => void;
}

export class FakeCore implements Core {
  private state: CoreSnapshot;
  private readonly engine: Engine;
  private readonly device: DeviceStore;
  private readonly host: HostStore;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private viewing: Surface | null = null;
  /** Agent runs followed to their end (or delivered), by run id. */
  private readonly followed = new Map<RunId, Unsubscribe>();
  /** Runs waiting on the owner, followed for their questions. */
  private readonly asking = new Map<RunId, Unsubscribe>();
  /** Auto's holds, by draft id, so Undo can stop one. */
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly jobs = new Map<string, WidgetJob>();
  private readonly offs: Unsubscribe[] = [];
  private firstRead = true;
  /** runs() reads, numbered, so a slow older read never overwrites a newer one. */
  private readsIssued = 0;
  private readsApplied = 0;
  private pendingSeq = 0;
  private disposed = false;
  /** The host blob's migration marker, kept on every save. */
  private readonly migratedFrom?: string;

  constructor(options: FakeCoreOptions) {
    this.engine = options.engine;
    this.device = options.device;
    this.host = options.host ?? new MemoryHostStore();
    this.now = options.now ?? Date.now;
    const stored = this.host.load();
    this.migratedFrom = stored?.migratedFrom;
    const now = this.now();
    const agents = options.agents ?? (stored?.agents.length ? stored.agents : seedAgents(now));
    const hostSettings = { ...DEFAULT_APP_SETTINGS, ...stored?.settings, ...pickHost(options.settings ?? {}) };
    const widgets = hostSettings.widgets.map((w) => (w.agentId ? w : { ...w, agentId: linkedAgent(w, agents) }));
    const settings: Settings = { ...hostSettings, widgets, ...this.device.get() };
    const extra = options.pending ?? [];
    this.pendingSeq = newestSeq(extra);
    this.state = {
      settings,
      agents,
      runningAgents: [],
      ...seedData(settings, now),
      unread: {},
      briefing: null,
      notices: [],
      widgetData: {},
      pending: extra,
      pendingMarker: { ...DEFAULT_PENDING_MARKER },
      service: null,
    };
    this.state = { ...this.state, pending: this.syncApprovals(this.state.drafts, this.state.pending) };
    this.saveHost();
    this.offs.push(this.device.subscribe((device) => this.set({ settings: { ...this.state.settings, ...device } })));
    this.offs.push(this.engine.onRunsChanged(() => this.readRuns()));
    this.offs.push(this.engine.onHostSettingsChanged((service) => this.set({ service })));
    this.readRuns();
    this.engine
      .hostSettings()
      .then((service) => this.set({ service }))
      .catch((error: unknown) => console.error("hostSettings() failed", error));
  }

  // ---- the store -----------------------------------------------------------------------------

  readonly snapshot = (): CoreSnapshot => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<CoreSnapshot>): void {
    if (this.disposed) return;
    let next = { ...this.state, ...patch };
    if (patch.pending && this.viewing?.kind === "pending") {
      next = { ...next, pendingMarker: { ...next.pendingMarker, seen: Math.max(next.pendingMarker.seen, newestSeq(next.pending)) } };
    }
    this.state = next;
    if (patch.settings || patch.agents) this.saveHost();
    for (const listener of this.listeners) listener();
  }

  /** The host keeps its app settings and the agent definitions (rlxd's settings API). */
  private saveHost(): void {
    const data = { settings: pickHost(this.state.settings), agents: this.state.agents };
    this.host.save(this.migratedFrom ? { ...data, migratedFrom: this.migratedFrom } : data);
  }

  view(surface: Surface | null): void {
    this.viewing = surface;
    if (surface?.kind === "channel" && this.state.unread[surface.id]) {
      this.set({ unread: { ...this.state.unread, [surface.id]: 0 } });
    }
    if (surface?.kind === "pending") this.seePending();
  }

  dispose(): void {
    for (const off of [...this.offs, ...this.followed.values(), ...this.asking.values()]) off();
    for (const timer of this.holds.values()) clearTimeout(timer);
    for (const job of this.jobs.values()) this.stopJob(job);
    this.holds.clear();
    this.jobs.clear();
    this.disposed = true;
  }

  // ---- settings ------------------------------------------------------------------------------

  async updateSettings(patch: SettingsPatch): Promise<void> {
    // Send modes are the gate's: they change only through setSendMode.
    const allowed: Partial<Settings> = { ...patch };
    delete allowed.sendModes;
    const device = pickDevice(allowed);
    const host = pickHost(allowed);
    if (Object.keys(host).length) this.set({ settings: { ...this.state.settings, ...host } });
    if (Object.keys(device).length) this.device.update(device);
    this.restartChangedJobs();
  }

  async setSendMode(connector: ConnectorId, mode: SendMode): Promise<boolean> {
    // The real core confirms Auto in its own native dialog before it changes anything; the
    // preview's typed confirmation stands in for it until then.
    this.set({ settings: { ...this.state.settings, sendModes: { ...this.state.settings.sendModes, [connector]: mode } } });
    return true;
  }

  async updateServiceSettings(patch: Partial<HostSettings>): Promise<void> {
    this.set({ service: await this.engine.updateHostSettings(patch) });
  }

  // ---- widgets and their data jobs -----------------------------------------------------------

  private setWidgets(widgets: WidgetInstance[]): void {
    this.set({ settings: { ...this.state.settings, widgets } });
  }

  async addWidget(widget: WidgetInstance): Promise<void> {
    const linked = widget.agentId ?? linkedAgent(widget, this.state.agents);
    this.setWidgets([...this.state.settings.widgets, linked ? { ...widget, agentId: linked } : widget]);
  }

  async removeWidget(id: string): Promise<void> {
    this.setWidgets(this.state.settings.widgets.filter((w) => w.id !== id));
  }

  async moveWidget(id: string, to: number): Promise<void> {
    const widgets = [...this.state.settings.widgets];
    const from = widgets.findIndex((w) => w.id === id);
    if (from < 0) return;
    const [moved] = widgets.splice(from, 1);
    if (moved) widgets.splice(Math.max(0, Math.min(widgets.length, to)), 0, moved);
    this.setWidgets(widgets);
  }

  private jobFor(widget: WidgetInstance): DataJob | null {
    return dataJob(widget, this.state.settings);
  }

  watchWidget(widget: WidgetInstance): Unsubscribe {
    const spec = this.jobFor(widget);
    if (!spec || this.disposed) return () => {};
    let job = this.jobs.get(widget.id);
    if (!job) {
      job = { widget, watchers: 0, key: "", stop: () => {} };
      this.jobs.set(widget.id, job);
    }
    job.widget = widget;
    job.watchers += 1;
    if (job.watchers === 1 || JSON.stringify(spec) !== job.key) this.startJob(job, true);
    const watched = job;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      watched.watchers -= 1;
      if (watched.watchers > 0) return;
      this.stopJob(watched);
      if (this.jobs.get(watched.widget.id) !== watched) return;
      this.jobs.delete(watched.widget.id);
      // Off screen, its data goes too: the next visit refreshes from scratch, as it always has.
      const { [watched.widget.id]: _dropped, ...rest } = this.state.widgetData;
      this.set({ widgetData: rest });
    };
  }

  async refreshWidget(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) this.refresh(job, true);
  }

  /** Refreshes now, then on the job's interval. */
  private startJob(job: WidgetJob, announce: boolean): void {
    const spec = this.jobFor(job.widget);
    if (!spec) return;
    this.stopJob(job);
    job.key = JSON.stringify(spec);
    this.refresh(job, announce);
    if (spec.everyMin) job.timer = setInterval(() => this.refresh(job, false), spec.everyMin * 60_000);
  }

  private stopJob(job: WidgetJob): void {
    if (job.timer) clearInterval(job.timer);
    job.timer = undefined;
    job.stop();
    job.stop = () => {};
  }

  /** Settings changed a watched widget's job (its interval, its prompt): start it again. */
  private restartChangedJobs(): void {
    for (const job of this.jobs.values()) {
      const spec = this.jobFor(job.widget);
      if (job.watchers > 0 && spec && JSON.stringify(spec) !== job.key) this.startJob(job, false);
    }
  }

  private setWidgetData(id: string, patch: Partial<WidgetData>): void {
    const current: WidgetData = this.state.widgetData[id] ?? { data: null, status: "refreshing", fetchedAt: null };
    this.set({ widgetData: { ...this.state.widgetData, [id]: { ...current, ...patch } } });
  }

  /**
   * One refresh: one engine run whose finished output is the data. A failed or empty refresh
   * keeps the last good data and reports `error`. `announce` shows "refreshing" (first load and
   * Refresh now); interval refreshes stay quiet.
   */
  private refresh(job: WidgetJob, announce: boolean): void {
    const spec = this.jobFor(job.widget);
    if (!spec) return;
    job.stop();
    const widgetId = job.widget.id;
    const id = newRunId();
    let active = true;
    let finished = false;
    let off: Unsubscribe = () => {};
    job.stop = () => {
      active = false;
      off();
      // A refresh nobody waits for any more is cancelled, not left to spend a turn.
      if (!finished) void this.engine.cancel(id).catch(() => {});
    };
    if (announce || !this.state.widgetData[widgetId]) this.setWidgetData(widgetId, { status: "refreshing" });
    const connectors = spec.mount.kind === "connectors" ? spec.mount.connectors : [];
    this.engine
      .run({ id, kind: spec.kind, prompt: spec.prompt, mount: spec.mount, needsConnectors: connectors, persist: false, agentId: spec.agentId, account: spec.account })
      .then(() => {
        if (!active) return;
        off = this.follow(id, ({ event }) => {
          if (event.type !== "finished") return;
          finished = true;
          if (!active) return;
          if (event.status === "done" && event.output !== undefined && event.output !== null) {
            const at = this.now();
            this.setWidgetData(widgetId, { data: event.output, status: "ok", fetchedAt: at });
            const outcome = refreshOutcome(event.output);
            // This widget is its agent's silent run: each fetch is that agent's latest outcome.
            if (outcome && spec.agentId) this.updateAgent(spec.agentId, { lastRun: { at, ...outcome, runId: id } });
          } else {
            this.setWidgetData(widgetId, { status: "error" });
          }
        });
      })
      .catch(() => {
        if (active) this.setWidgetData(widgetId, { status: "error" });
      });
  }

  // ---- agents --------------------------------------------------------------------------------

  private updateAgent(id: string, patch: Partial<Agent>): void {
    this.set({ agents: this.state.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  }

  async wake(agentId: string): Promise<void> {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent || this.state.runningAgents.includes(agent.id)) return;
    await this.engine.run({
      id: newRunId(),
      kind: "task",
      prompt: `${agent.name}\n${agent.purpose}`,
      jobId: agent.jobId,
      agentId: agent.id,
      loud: agent.mode === "loud",
      account: agent.account ?? AUTO_ACCOUNT,
      outputSchema: agent.role === "briefing" ? BRIEFING_SCHEMA : undefined,
      mount: { kind: "connectors", connectors: agent.connectors },
      needsConnectors: [],
      persist: agent.mode === "loud",
    });
  }

  async setPaused(agentId: string, paused: boolean): Promise<void> {
    this.updateAgent(agentId, { state: paused ? "paused" : "asleep" });
  }

  async editAgent(agentId: string, next: Proposal): Promise<void> {
    const others = this.state.agents.filter((a) => a.id !== agentId);
    this.updateAgent(agentId, { ...next, avatar: avatarFor(next.name, others) });
  }

  // ---- following the engine's runs -----------------------------------------------------------

  /** Follows a run's events until it finishes; returns a function that stops following. */
  private follow(runId: RunId, onEvent: (event: Seq<RunEvent>) => void): Unsubscribe {
    let done = false;
    let off: Unsubscribe | undefined;
    const stop = () => {
      done = true;
      off?.();
    };
    off = this.engine.attach(runId, 1, (event) => {
      if (done) return;
      onEvent(event);
      if (event.event.type === "finished") stop();
    });
    if (done) off();
    return stop;
  }

  private untilFinished(runId: RunId, onEvent: (event: RunEvent) => void = () => {}): Promise<Finished> {
    return new Promise((resolve) => {
      this.follow(runId, ({ event }) => {
        onEvent(event);
        if (event.type === "finished") resolve(event);
      });
    });
  }

  private readRuns(): void {
    const read = ++this.readsIssued;
    this.engine
      .runs()
      .then((runs) => {
        if (this.disposed || read < this.readsApplied) return;
        this.readsApplied = read;
        this.onRuns(runs);
      })
      .catch((error: unknown) => console.error("runs() failed", error));
  }

  private onRuns(runs: RunSummary[]): void {
    const first = this.firstRead;
    this.firstRead = false;

    const running = [...new Set(runs.filter((r) => isAgentRun(r) && (r.state === "running" || r.state === "queued")).map((r) => r.agentId ?? ""))];
    if (!sameList(running, this.state.runningAgents)) this.set({ runningAgents: running });

    // Runs are newest first, so the first ended run met per job is that job's latest outcome.
    const latestSeen = new Set<string>();
    for (const run of runs) {
      if (!isAgentRun(run) || this.followed.has(run.id)) continue;
      const agentId = run.agentId ?? "";
      if (first && (run.state === "done" || run.state === "failed")) {
        // It ended while the app was closed: deliver the job's latest outcome (the 9:00
        // briefing), once; older ones are history.
        const latest = !latestSeen.has(run.jobId ?? "");
        latestSeen.add(run.jobId ?? "");
        this.followed.set(run.id, () => {});
        if (latest) void this.deliverLate(run.id, agentId);
        continue;
      }
      this.followed.set(
        run.id,
        this.follow(run.id, ({ event }) => {
          if (event.type === "finished") this.finishAgentRun(agentId, run.id, event.status, event.output, false);
        }),
      );
    }

    const waiting = new Set(runs.filter((r) => r.state === "needs-you").map((r) => r.id));
    for (const run of runs) {
      if (!waiting.has(run.id) || this.asking.has(run.id)) continue;
      this.asking.set(
        run.id,
        this.follow(run.id, ({ seq, event }) => {
          if (event.type === "question") this.addQuestion(run, seq, event.text);
        }),
      );
    }
    for (const [runId, off] of this.asking) {
      if (waiting.has(runId)) continue;
      off();
      this.asking.delete(runId);
      this.closeQuestions(runId, runs.find((r) => r.id === runId)?.state === "failed");
    }
  }

  /** An outcome that ended before the core started, read with run.get. */
  private async deliverLate(runId: RunId, agentId: string): Promise<void> {
    const result = await this.engine.getRun(runId).catch(() => null);
    if (!result?.status) return;
    this.finishAgentRun(agentId, runId, result.status, result.output, true);
  }

  /**
   * An agent's run ended: its output becomes messages and cards, and the agent sleeps again.
   * Once per run: an outcome already recorded from this run is never delivered twice. A late
   * outcome (the app was closed) fires no notification: the service's tray already did.
   */
  private finishAgentRun(agentId: string, runId: RunId, status: RunStatus, output: unknown, late: boolean): void {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent || agent.lastRun?.runId === runId) return;
    const at = this.now();
    if (status !== "done") {
      this.updateAgent(agent.id, { lastRun: { at, outcome: status === "cancelled" ? "Stopped" : "Failed", modelTurn: false, runId } });
      this.post(agent.id, "system", { text: `Woke and ${status === "cancelled" ? "was stopped" : "failed"}. Asleep again.` });
      return;
    }
    if (agent.role === "briefing" && output && typeof output === "object" && "doNow" in output) {
      this.deliverBriefing(agent, runId, output as Briefing, late);
      return;
    }
    const result = (output ?? {}) as { outcome?: string; modelTurn?: boolean };
    const outcome = result.outcome ?? "Done";
    this.updateAgent(agent.id, { lastRun: { at, outcome, modelTurn: result.modelTurn ?? false, runId } });
    this.post(agent.id, "system", { text: `Woke · ${outcome} · asleep again` });
    if (agent.mode === "loud" && !late) this.notify(agent.id, agent.name, outcome);
  }

  private deliverBriefing(agent: Agent, runId: RunId, b: Briefing, late: boolean): void {
    const at = this.now();
    const priority: PriorityCard = { type: "priority", title: "Start of day", doNow: b.doNow, today: b.today, waiting: b.waiting };
    const first = this.state.settings.ownerName.split(" ")[0] ?? "";
    const channel = agent.id;
    if (agent.outputs.includes("channel")) {
      this.post(channel, "agent", { text: `Good morning ${first}. ${b.summary}` });
      this.post(channel, "agent", { card: priority });
      this.post(channel, "agent", { card: { type: "promise", ...b.promise } });
      this.post(channel, "agent", { card: { type: "checklist", title: "Before 10:00", items: b.checklist.map((text) => ({ text, done: false })) } });
      const draftId = this.addDraft({
        origin: "task",
        connector: b.draft.connector,
        destination: b.draft.to,
        subject: b.draft.subject,
        body: b.draft.body,
        context: b.draft.context,
      });
      this.post(channel, "agent", { text: "I drafted one reply. Nothing sends until you say so." });
      this.post(channel, "agent", { card: { type: "email-draft", draftId } });
      this.post(channel, "agent", {
        card: {
          type: "needs-context",
          id: nextId("nc"),
          question: b.needsContext.question,
          to: b.needsContext.to,
          subject: b.needsContext.subject,
          connector: b.needsContext.connector,
          sources: b.needsContext.sources,
          draftTemplate: b.needsContext.draftTemplate,
        },
      });
    }
    if (agent.outputs.includes("dashboard")) this.set({ briefing: { at, card: priority } });
    if (agent.mode === "loud" && !late) this.notify(channel, agent.name, `${b.doNow.length} to do now. First: ${b.doNow[0]?.text ?? ""}`);
    const outcome = `Posted the briefing: ${b.doNow.length} now, ${b.today.length} today, ${b.waiting.length} waiting on you`;
    this.updateAgent(agent.id, { lastRun: { at, outcome, modelTurn: true, runId } });
  }

  private notify(channel: string, title: string, body: string): void {
    this.set({ notices: [...this.state.notices, { id: nextId("n"), channel, title, body }].slice(-3) });
  }

  async dismissNotice(id: string): Promise<void> {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) });
  }

  // ---- conversations -------------------------------------------------------------------------

  private post(channel: string, from: Message["from"], body: Pick<Message, "text" | "card" | "streaming">): string {
    const message: Message = { id: nextId("m"), channel, from, at: this.now(), ...body };
    const here = this.viewing?.kind === "channel" && this.viewing.id === channel;
    const unread = from === "agent" && !here ? { ...this.state.unread, [channel]: (this.state.unread[channel] ?? 0) + 1 } : this.state.unread;
    this.set({ messages: [...this.state.messages, message], unread });
    return message.id;
  }

  private patchMessage(id: string, patch: (message: Message) => Partial<Message>): void {
    this.set({ messages: this.state.messages.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)) });
  }

  private setCard(id: string, card: Card): void {
    this.patchMessage(id, () => ({ card }));
  }

  async sendMessage(channel: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    this.post(channel, "owner", { text: body });
    if (channel === MANAGER_ID) {
      // The manager turns what the owner said into a proposal card (a parse_instruction run).
      const finished = await this.engine
        .run({ id: newRunId(), kind: "parse_instruction", prompt: body, mount: { kind: "no_tools" }, needsConnectors: [], persist: false })
        .then((run) => this.untilFinished(run))
        .catch(() => null);
      const output = finished?.output as (Proposal & { reply?: string }) | undefined;
      if (finished?.status !== "done" || !output) {
        this.post(channel, "agent", { text: "Sorry, I couldn't work that out. Try saying what you want and when." });
        return;
      }
      const { reply, ...proposal } = output;
      this.post(channel, "agent", { text: reply ?? "Here's what I'd set up." });
      this.post(channel, "agent", { card: { type: "proposal", id: nextId("p"), proposal, status: "proposed" } });
      return;
    }
    // An agent's channel: a chat turn with that agent; its reply streams in.
    const replyId = this.post(channel, "agent", { text: "", streaming: true });
    try {
      const run = await this.engine.run({ id: newRunId(), kind: "task", prompt: body, agentId: channel, mount: { kind: "no_tools" }, needsConnectors: [], persist: true });
      await this.untilFinished(run, (event) => {
        if (event.type === "text") this.patchMessage(replyId, (m) => ({ text: (m.text ?? "") + event.delta }));
      });
      this.patchMessage(replyId, () => ({ streaming: false }));
    } catch {
      // The turn never started: say so, rather than leave a reply streaming forever.
      this.patchMessage(replyId, (m) => ({ text: m.text || "Sorry, that didn't go through. Try again.", streaming: false }));
    }
  }

  async answerNeedsContext(messageId: string, answer: string): Promise<void> {
    const text = answer.trim();
    const message = this.state.messages.find((m) => m.id === messageId);
    const card = message?.card;
    if (!text || !message || card?.type !== "needs-context") return;
    const draftId = this.addDraft({
      origin: "task",
      connector: card.connector,
      destination: card.to,
      subject: card.subject,
      body: card.draftTemplate.replace("{answer}", asSentence(text)),
      context: `Drafted from your answer: “${text}”`,
    });
    this.setCard(message.id, { ...card, answered: text });
    this.post(message.channel, "owner", { text });
    this.post(message.channel, "agent", { card: { type: "email-draft", draftId } });
  }

  async confirmProposal(messageId: string, value: Proposal): Promise<Agent> {
    const agents = this.state.agents;
    const slug = value.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const taken = new Set(agents.map((a) => a.id));
    let id = value.role === "briefing" && !taken.has(START_OF_DAY_ID) ? START_OF_DAY_ID : slug;
    for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
    const agent: Agent = {
      id,
      jobId: jobIdFor(id),
      name: value.name.trim() || "New agent",
      avatar: avatarFor(value.name, agents),
      purpose: value.purpose || "Created with the manager.",
      role: value.role,
      connectors: value.connectors,
      schedule: value.schedule,
      mode: value.mode,
      outputs: value.outputs,
      state: "asleep",
    };
    this.set({ agents: [...agents, agent] });
    const message = this.state.messages.find((m) => m.id === messageId);
    if (message?.card?.type === "proposal") {
      this.setCard(messageId, { ...message.card, proposal: value, status: "confirmed" });
      const now = this.now();
      this.post(message.channel, "agent", {
        text: `Done. ${value.name} is scheduled for ${scheduleLabel(value.schedule).toLowerCase()}. It sleeps until then; next wake ${wakeLabel(nextWake(value.schedule, now), now)}.`,
      });
    }
    return agent;
  }

  async cancelProposal(messageId: string): Promise<void> {
    const card = this.state.messages.find((m) => m.id === messageId)?.card;
    if (card?.type === "proposal") this.setCard(messageId, { ...card, status: "cancelled" });
  }

  // ---- drafts and the send gate --------------------------------------------------------------

  private setDrafts(drafts: Draft[], extra: Partial<CoreSnapshot> = {}): void {
    this.set({ ...extra, drafts, pending: this.syncApprovals(drafts, extra.pending ?? this.state.pending) });
  }

  private patchDraft(id: string, patch: Partial<Draft>): void {
    this.setDrafts(this.state.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  /** The core mints the id (architecture §8.2). */
  private addDraft(draft: NewDraft): string {
    const id = nextId("d");
    this.setDrafts([{ ...draft, id, status: "pending", createdAt: this.now() }, ...this.state.drafts]);
    return id;
  }

  async createDraft(draft: NewDraft): Promise<string> {
    return this.addDraft(draft);
  }

  async editDraft(id: string, body: string): Promise<void> {
    this.patchDraft(id, { body });
  }

  private removeDraft(id: string): void {
    this.clearHold(id);
    this.setDrafts(
      this.state.drafts.filter((d) => d.id !== id),
      { pending: this.closeApproval(id, "dismissed") },
    );
  }

  async discardDraft(id: string): Promise<void> {
    this.removeDraft(id);
  }

  async approveDraft(id: string): Promise<void> {
    this.patchDraft(id, { status: "approved" });
  }

  async approveAndSend(id: string): Promise<void> {
    this.deliver(id, "owner");
  }

  async send(id: string): Promise<SendResult> {
    const draft = this.state.drafts.find((d) => d.id === id);
    if (!draft || draft.status === "held") return "refused";
    const { mode, covered } = sendCheck(draft, this.state.settings, this.state.approvals);
    if (draft.status === "approved") {
      this.deliver(id, "owner");
      return "sent";
    }
    if (mode === "auto") {
      this.patchDraft(id, { status: "held" });
      this.holds.set(
        id,
        setTimeout(() => {
          this.holds.delete(id);
          this.deliver(id, "auto");
        }, HOLD_MS),
      );
      return "held";
    }
    if (mode === "preapproved" && covered) {
      this.deliver(id, "standing approval");
      return "sent";
    }
    return "refused";
  }

  async undoSend(id: string): Promise<void> {
    if (!this.clearHold(id)) return;
    this.patchDraft(id, { status: "pending" });
  }

  private clearHold(id: string): boolean {
    const timer = this.holds.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.holds.delete(id);
    return true;
  }

  /** Sends a draft: it leaves the queue and enters the activity log with the sign-off. */
  private deliver(id: string, approvedBy: ActivityItem["approvedBy"]): void {
    const draft = this.state.drafts.find((d) => d.id === id);
    if (!draft) return;
    this.clearHold(id);
    const { agentName, ownerName } = this.state.settings;
    const item: ActivityItem = {
      id: `act-${draft.id}`,
      at: this.now(),
      connector: draft.connector,
      destination: draft.destination,
      subject: draft.subject,
      body: draft.body,
      signOff: signOffText(agentName, ownerName),
      approvedBy,
    };
    this.setDrafts(
      this.state.drafts.filter((d) => d.id !== id),
      { activity: [item, ...this.state.activity], pending: this.closeApproval(id, "answered", approvedBy === "owner" ? "person" : undefined) },
    );
  }

  async revokeApproval(id: string): Promise<void> {
    this.set({ approvals: this.state.approvals.map((a) => (a.id === id ? { ...a, status: "revoked" } : a)) });
  }

  // ---- Pending on you ------------------------------------------------------------------------

  /** One open approval item per draft waiting on the gate, so Pending is the one list. */
  private syncApprovals(drafts: Draft[], pending: PendingItem[]): PendingItem[] {
    const known = new Set(pending.map((item) => item.draftId).filter(Boolean));
    const added: PendingItem[] = drafts
      .filter((d) => !known.has(d.id))
      .map((d) => ({
        id: `approval-${d.id}`,
        seq: ++this.pendingSeq,
        asker: "send gate",
        kind: "approval",
        title: `To ${d.destination}`,
        text: d.body,
        suggested: [{ label: APPROVE_CHOICE }, { label: DISCARD_CHOICE }],
        // Sending on the owner's behalf: only they decide.
        ownerOnly: true,
        createdAt: d.createdAt,
        status: "open",
        draftId: d.id,
      }));
    return added.length ? [...pending, ...added] : pending;
  }

  private closeApproval(draftId: string, status: "answered" | "dismissed", answeredBy?: "person"): PendingItem[] {
    const at = this.now();
    return this.state.pending.map((item) =>
      item.draftId === draftId && item.status === "open"
        ? { ...item, status, answer: status === "answered" ? "Sent" : undefined, answeredBy: status === "answered" ? answeredBy : undefined, answeredAt: at }
        : item,
    );
  }

  private patchPending(id: string, patch: Partial<PendingItem>): void {
    this.set({ pending: this.state.pending.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  private addQuestion(run: RunSummary, seq: number, text: string): void {
    const id = `question-${run.id}-${seq}`;
    if (this.state.pending.some((item) => item.id === id)) return;
    const item: PendingItem = {
      id,
      seq: ++this.pendingSeq,
      asker: run.agentId ?? `run ${run.id}`,
      kind: "question",
      title: run.title,
      text,
      suggested: [],
      ownerOnly: false,
      createdAt: this.now(),
      status: "open",
      runId: run.id,
    };
    this.set({ pending: [...this.state.pending, item] });
  }

  /** A run stopped waiting: answered elsewhere, or (failed, cancelled) its questions are moot. */
  private closeQuestions(runId: string, moot: boolean): void {
    if (!this.state.pending.some((item) => item.runId === runId && item.status === "open")) return;
    const at = this.now();
    this.set({
      pending: this.state.pending.map((item) => {
        if (item.runId !== runId || item.status !== "open") return item;
        return moot ? { ...item, status: "dismissed", answeredAt: at } : { ...item, status: "answered", answeredBy: "person", answeredAt: at };
      }),
    });
  }

  async answerPending(id: string, answer: PendingAnswer): Promise<void> {
    const item = this.state.pending.find((i) => i.id === id);
    const text = answer.kind === "choice" ? answer.label : answer.text.trim();
    if (!item || !text) return;
    if (item.kind === "approval") {
      if (item.status !== "open" || !item.draftId) return;
      // Only an explicit choice decides a send; free text is kept as a note and never sends.
      if (answer.kind === "text") {
        this.patchPending(id, { note: text });
        return;
      }
      if (answer.label === APPROVE_CHOICE) this.deliver(item.draftId, "owner");
      else if (answer.label === DISCARD_CHOICE) this.removeDraft(item.draftId);
      return;
    }
    if (answer.kind === "choice" && !item.suggested.some((s) => s.label === answer.label)) return;
    const at = this.now();
    if (item.status === "assumed") {
      // A changed answer replaces the manager's assumption; it redoes what depended on it.
      this.patchPending(id, { status: "answered", answer: text, answeredBy: "person", answeredAt: at, changed: text !== item.answer });
      return;
    }
    if (item.status !== "open") return;
    this.patchPending(id, { status: "answered", answer: text, answeredBy: "person", answeredAt: at });
    if (item.runId) await this.engine.resume(item.runId, text);
  }

  async confirmAssumed(id: string): Promise<void> {
    const item = this.state.pending.find((i) => i.id === id);
    if (item?.status !== "assumed") return;
    this.patchPending(id, { status: "answered", confirmed: true, answeredAt: this.now() });
  }

  async dismissPending(id: string): Promise<void> {
    const item = this.state.pending.find((i) => i.id === id);
    if (!item || item.status !== "open") return;
    if (item.kind === "approval" && item.draftId) {
      this.removeDraft(item.draftId);
      return;
    }
    this.patchPending(id, { status: "dismissed", answeredAt: this.now() });
  }

  private seePending(): void {
    const seen = Math.max(this.state.pendingMarker.seen, newestSeq(this.state.pending));
    if (seen !== this.state.pendingMarker.seen) this.set({ pendingMarker: { ...this.state.pendingMarker, seen } });
  }

  async markPendingSeen(): Promise<void> {
    this.seePending();
  }

  async setPendingMuted(muted: boolean): Promise<void> {
    this.set({ pendingMarker: { ...this.state.pendingMarker, muted } });
  }

  async setPendingEnabled(enabled: boolean): Promise<void> {
    this.set({ pendingMarker: { ...this.state.pendingMarker, enabled } });
  }

  /** The manager assumes the first suggested answer for open items past their time (never owner-only ones). */
  assumeDue(): void {
    const now = this.now();
    if (!this.state.pending.some((item) => canAssume(item, now))) return;
    this.set({
      pending: this.state.pending.map((item) =>
        canAssume(item, now) ? { ...item, status: "assumed", answer: item.suggested[0]?.label, answeredBy: "manager-assumed", answeredAt: now } : item,
      ),
    });
  }
}
