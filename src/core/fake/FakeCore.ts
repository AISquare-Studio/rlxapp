/**
 * FakeCore: the Core interface in memory, over any Engine. It plays the app core's parts
 * (architecture §2): the agent scheduler's follow-up (an agent's run becomes channel messages,
 * cards, drafts, the Home briefing and a notification), the send gate (Draft, Pre-approved,
 * Auto's 10 s hold) and storage. The host's data lives in memory here, as rlxd's settings API
 * will keep it; device-local settings go to this device's storage.
 */
import { BRIEFING_SCHEMA, isAgentRun, type Briefing } from "../../engine/runs.ts";
import { AUTO_ACCOUNT, type Engine, type HostSettings, type RunEvent, type RunId, type RunSummary, type Seq, type Unsubscribe } from "../../engine/types.ts";
import { MANAGER_ID, START_OF_DAY_ID, avatarFor, jobIdFor, nextWake, scheduleLabel, seedAgents, wakeLabel, type Agent, type AgentRun } from "../../state/agents.ts";
import {
  DEFAULT_SETTINGS,
  DEVICE_SETTING_KEYS,
  signOffText,
  type ActivityItem,
  type AppSettings,
  type Card,
  type Draft,
  type Message,
  type Proposal,
  type Settings,
  type WidgetInstance,
} from "../../state/model.ts";
import { deviceStorage, loadDeviceSettings, pickDevice, saveDeviceSettings, type DeviceStorage } from "../device.ts";
import { HOLD_MS, sendCheck, type SendResult } from "../gate.ts";
import { newRunId, nextId } from "../ids.ts";
import { DEFAULT_PENDING_MARKER, canAssume, newestSeq, type PendingItem } from "../pending.ts";
import type { Core, CoreSnapshot, NewDraft, PriorityCard, Surface } from "../types.ts";
import { seedData } from "./seed.ts";

export interface FakeCoreOptions {
  engine: Engine;
  /** Seeds the fake host's app settings, and overrides this device's (tests; the preview's e2e). */
  settings?: Partial<Settings>;
  /** The host's agents; the four demo agents when absent. */
  agents?: Agent[];
  now?: () => number;
  /** Where device-local settings persist: localStorage by default; null keeps them in memory. */
  storage?: DeviceStorage | null;
}

/** The host's part of a settings object: everything but the device keys (and nothing unknown). */
function pickHost(value: Partial<Settings>): Partial<AppSettings> {
  const out: Partial<Record<string, unknown>> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if ((DEVICE_SETTING_KEYS as readonly string[]).includes(key) || !(key in value)) continue;
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out as Partial<AppSettings>;
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

export class FakeCore implements Core {
  private state: CoreSnapshot;
  private readonly engine: Engine;
  private readonly now: () => number;
  private readonly storage: DeviceStorage | null;
  private readonly listeners = new Set<() => void>();
  private viewing: Surface | null = null;
  /** Agent runs followed to their end, by run id (a no-op for runs that ended before the core started). */
  private readonly followed = new Map<RunId, Unsubscribe>();
  /** Runs waiting on the owner, followed for their questions. */
  private readonly asking = new Map<RunId, Unsubscribe>();
  /** Auto's holds, by draft id, so Undo can stop one. */
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offs: Unsubscribe[] = [];
  private firstRead = true;
  /** runs() reads, numbered, so a slow older read never overwrites a newer one. */
  private readsIssued = 0;
  private readsApplied = 0;
  private pendingSeq = 0;
  private disposed = false;

  constructor(options: FakeCoreOptions) {
    this.engine = options.engine;
    this.now = options.now ?? Date.now;
    this.storage = options.storage === undefined ? deviceStorage() : options.storage;
    const given = options.settings ?? {};
    const settings: Settings = { ...DEFAULT_SETTINGS, ...pickHost(given), ...loadDeviceSettings(this.storage), ...pickDevice(given) };
    const now = this.now();
    const seed = seedData(settings, now);
    this.state = {
      settings,
      agents: options.agents ?? seedAgents(now),
      runningAgents: [],
      ...seed,
      unread: {},
      briefing: null,
      notices: [],
      pending: [],
      pendingMarker: { ...DEFAULT_PENDING_MARKER },
      service: null,
    };
    this.state = { ...this.state, pending: this.syncApprovals(this.state.drafts, this.state.pending) };
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
    for (const listener of this.listeners) listener();
  }

  view(surface: Surface | null): void {
    this.viewing = surface;
    if (surface?.kind === "channel" && this.state.unread[surface.id]) {
      this.set({ unread: { ...this.state.unread, [surface.id]: 0 } });
    }
    if (surface?.kind === "pending") this.markPendingSeen();
  }

  dispose(): void {
    for (const off of [...this.offs, ...this.followed.values(), ...this.asking.values()]) off();
    for (const timer of this.holds.values()) clearTimeout(timer);
    this.holds.clear();
    this.disposed = true;
  }

  // ---- settings ------------------------------------------------------------------------------

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.state.settings, ...patch };
    this.set({ settings });
    if (Object.keys(pickDevice(patch)).length) saveDeviceSettings(this.storage, settings);
  }

  async updateServiceSettings(patch: Partial<HostSettings>): Promise<void> {
    this.set({ service: await this.engine.updateHostSettings(patch) });
  }

  // ---- widgets -------------------------------------------------------------------------------

  private setWidgets(widgets: WidgetInstance[]): void {
    this.set({ settings: { ...this.state.settings, widgets } });
  }

  addWidget(widget: WidgetInstance): void {
    this.setWidgets([...this.state.settings.widgets, widget]);
  }

  removeWidget(id: string): void {
    this.setWidgets(this.state.settings.widgets.filter((w) => w.id !== id));
  }

  moveWidget(id: string, to: number): void {
    const widgets = [...this.state.settings.widgets];
    const from = widgets.findIndex((w) => w.id === id);
    if (from < 0) return;
    const [moved] = widgets.splice(from, 1);
    if (moved) widgets.splice(Math.max(0, Math.min(widgets.length, to)), 0, moved);
    this.setWidgets(widgets);
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

  setPaused(agentId: string, paused: boolean): void {
    this.updateAgent(agentId, { state: paused ? "paused" : "asleep" });
  }

  editAgent(agentId: string, next: Proposal): void {
    const others = this.state.agents.filter((a) => a.id !== agentId);
    this.updateAgent(agentId, { ...next, avatar: avatarFor(next.name, others) });
  }

  recordAgentRun(agentId: string, run: AgentRun): void {
    this.updateAgent(agentId, { lastRun: run });
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

    for (const run of runs) {
      if (!isAgentRun(run) || this.followed.has(run.id)) continue;
      // Runs that ended before the core started are history, not news.
      if (first && (run.state === "done" || run.state === "failed")) {
        this.followed.set(run.id, () => {});
        continue;
      }
      const agentId = run.agentId;
      this.followed.set(
        run.id,
        this.follow(run.id, ({ event }) => {
          if (event.type === "finished") this.finishAgentRun(agentId ?? "", event.status, event.output);
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
      this.closeQuestions(runId);
    }
  }

  /** An agent's run ended: its output becomes messages and cards, and the agent sleeps again. */
  private finishAgentRun(agentId: string, status: string, output: unknown): void {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;
    const at = this.now();
    if (status !== "done") {
      this.updateAgent(agent.id, { lastRun: { at, outcome: status === "cancelled" ? "Stopped" : "Failed", modelTurn: false } });
      this.post(agent.id, "system", { text: `Woke and ${status === "cancelled" ? "was stopped" : "failed"}. Asleep again.` });
      return;
    }
    if (agent.role === "briefing" && output && typeof output === "object" && "doNow" in output) {
      this.deliverBriefing(agent, output as Briefing);
      return;
    }
    const result = (output ?? {}) as { outcome?: string; modelTurn?: boolean };
    const outcome = result.outcome ?? "Done";
    this.updateAgent(agent.id, { lastRun: { at, outcome, modelTurn: result.modelTurn ?? false } });
    this.post(agent.id, "system", { text: `Woke · ${outcome} · asleep again` });
    if (agent.mode === "loud") this.notify(agent.id, agent.name, outcome);
  }

  private deliverBriefing(agent: Agent, b: Briefing): void {
    const at = this.now();
    const priority: PriorityCard = { type: "priority", title: "Start of day", doNow: b.doNow, today: b.today, waiting: b.waiting };
    const first = this.state.settings.ownerName.split(" ")[0] ?? "";
    const channel = agent.id;
    if (agent.outputs.includes("channel")) {
      this.post(channel, "agent", { text: `Good morning ${first}. ${b.summary}` });
      this.post(channel, "agent", { card: priority });
      this.post(channel, "agent", { card: { type: "promise", ...b.promise } });
      this.post(channel, "agent", { card: { type: "checklist", title: "Before 10:00", items: b.checklist.map((text) => ({ text, done: false })) } });
      const draftId = this.createDraft({
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
    if (agent.mode === "loud") this.notify(channel, agent.name, `${b.doNow.length} to do now. First: ${b.doNow[0]?.text ?? ""}`);
    const outcome = `Posted the briefing: ${b.doNow.length} now, ${b.today.length} today, ${b.waiting.length} waiting on you`;
    this.updateAgent(agent.id, { lastRun: { at, outcome, modelTurn: true } });
  }

  private notify(channel: string, title: string, body: string): void {
    this.set({ notices: [...this.state.notices, { id: nextId("n"), channel, title, body }].slice(-3) });
  }

  dismissNotice(id: string): void {
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
      const run = await this.engine.run({ id: newRunId(), kind: "parse_instruction", prompt: body, mount: { kind: "no_tools" }, needsConnectors: [], persist: false });
      const finished = await this.untilFinished(run);
      const output = finished.output as (Proposal & { reply?: string }) | undefined;
      if (finished.status !== "done" || !output) {
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
    const run = await this.engine.run({
      id: newRunId(),
      kind: "task",
      prompt: body,
      agentId: channel,
      mount: { kind: "no_tools" },
      needsConnectors: [],
      persist: true,
    });
    await this.untilFinished(run, (event) => {
      if (event.type === "text") this.patchMessage(replyId, (m) => ({ text: (m.text ?? "") + event.delta }));
    });
    this.patchMessage(replyId, () => ({ streaming: false }));
  }

  answerNeedsContext(messageId: string, answer: string): void {
    const text = answer.trim();
    const message = this.state.messages.find((m) => m.id === messageId);
    const card = message?.card;
    if (!text || !message || card?.type !== "needs-context") return;
    const draftId = this.createDraft({
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

  confirmProposal(messageId: string, value: Proposal): Agent {
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

  cancelProposal(messageId: string): void {
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

  createDraft(draft: NewDraft): string {
    const id = nextId("d");
    this.setDrafts([{ ...draft, id, status: "pending", createdAt: this.now() }, ...this.state.drafts]);
    return id;
  }

  editDraft(id: string, body: string): void {
    this.patchDraft(id, { body });
  }

  discardDraft(id: string): void {
    this.clearHold(id);
    const pending = this.closeApproval(id, "dismissed");
    this.setDrafts(
      this.state.drafts.filter((d) => d.id !== id),
      { pending },
    );
  }

  approveDraft(id: string): void {
    this.patchDraft(id, { status: "approved" });
  }

  approveAndSend(id: string): void {
    this.deliver(id, "owner");
  }

  send(id: string): SendResult {
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

  undoSend(id: string): void {
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
    const pending = this.closeApproval(id, "answered", approvedBy === "owner" ? "person" : undefined);
    this.setDrafts(
      this.state.drafts.filter((d) => d.id !== id),
      { activity: [item, ...this.state.activity], pending },
    );
  }

  revokeApproval(id: string): void {
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
        suggested: [{ label: "Approve and send" }, { label: "Discard" }],
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

  /** A run stopped waiting (answered elsewhere, or cancelled): its questions leave Open. */
  private closeQuestions(runId: string): void {
    if (!this.state.pending.some((item) => item.runId === runId && item.status === "open")) return;
    const at = this.now();
    this.set({
      pending: this.state.pending.map((item) => (item.runId === runId && item.status === "open" ? { ...item, status: "answered", answeredBy: "person", answeredAt: at } : item)),
    });
  }

  async answerPending(id: string, answer: string): Promise<void> {
    const item = this.state.pending.find((i) => i.id === id);
    const text = answer.trim();
    if (!item || item.status !== "open" || !text) return;
    if (item.kind === "approval" && item.draftId) {
      if (text === "Discard") this.discardDraft(item.draftId);
      else this.approveAndSend(item.draftId);
      return;
    }
    const at = this.now();
    this.set({ pending: this.state.pending.map((i) => (i.id === id ? { ...i, status: "answered", answer: text, answeredBy: "person", answeredAt: at } : i)) });
    if (item.runId) await this.engine.resume(item.runId, text);
  }

  dismissPending(id: string): void {
    const item = this.state.pending.find((i) => i.id === id);
    if (!item || item.status !== "open") return;
    if (item.kind === "approval" && item.draftId) {
      this.discardDraft(item.draftId);
      return;
    }
    this.set({ pending: this.state.pending.map((i) => (i.id === id ? { ...i, status: "dismissed", answeredAt: this.now() } : i)) });
  }

  markPendingSeen(): void {
    const seen = Math.max(this.state.pendingMarker.seen, newestSeq(this.state.pending));
    if (seen !== this.state.pendingMarker.seen) this.set({ pendingMarker: { ...this.state.pendingMarker, seen } });
  }

  setPendingMuted(muted: boolean): void {
    this.set({ pendingMarker: { ...this.state.pendingMarker, muted } });
  }

  setPendingEnabled(enabled: boolean): void {
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
