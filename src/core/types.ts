/**
 * The Core interface: the app core the screens talk to (architecture §2: scheduler, send gate,
 * storage). It owns the product state: settings, agents and their runs' outcomes, conversations,
 * drafts, standing approvals, activity, notifications, widget data and Pending. The engine
 * (rlxd) does the agentic work underneath; the React tree keeps only navigation and toasts.
 *
 * Every mutator returns a Promise: the real core (Rust, and rlxd behind it) decides, mints ids
 * and may ask the owner in a native dialog before it resolves. The snapshot follows its
 * changes; screens never assume a change landed synchronously. `snapshot`, `subscribe`, `view`,
 * `watchWidget` and `dispose` are local registrations and stay synchronous.
 *
 * Storage: the host's app settings and agent definitions go to the host (rlxd's settings API,
 * handoff addendum §4), so every device on that host sees them; device-local settings stay in
 * this device's `DeviceStore`. `FakeCore` (./fake/) implements this over any `Engine`.
 */
import type { HostSettings, Unsubscribe } from "../engine/types.ts";
import type { Agent } from "../state/agents.ts";
import type { ActivityItem, Card, Draft, Message, Notice, Proposal, SendMode, Settings, StandingApproval, WidgetInstance } from "../state/model.ts";
import type { ConnectorId } from "./connectors.ts";
import type { SendResult } from "./gate.ts";
import type { PendingAnswer, PendingItem, PendingMarker } from "./pending.ts";

/** What a window has on screen, so what it shows isn't counted unread. */
export type Surface = { kind: "channel"; id: string } | { kind: "pending" };

export type PriorityCard = Extract<Card, { type: "priority" }>;

/** A widget's data, from its data job: the last good output, kept through a failed refresh. */
export interface WidgetData {
  /** null until the first good refresh. */
  data: unknown;
  status: "refreshing" | "ok" | "error";
  fetchedAt: number | null;
}

/** Everything the core knows, as one immutable value; a new object after every change. */
export interface CoreSnapshot {
  /** The host's app settings and this device's settings, as one view. */
  settings: Settings;
  /** The owner's agents (host data). */
  agents: Agent[];
  /** Ids of agents whose job has a live run (queued or running). */
  runningAgents: string[];
  drafts: Draft[];
  approvals: StandingApproval[];
  activity: ActivityItem[];
  messages: Message[];
  /** Unread agent messages, by channel. */
  unread: Record<string, number>;
  /** Home's "Start of day" section: the latest briefing. */
  briefing: { at: number; card: PriorityCard } | null;
  /** Notifications a loud run fired (mock system notifications in the window). */
  notices: Notice[];
  /** Each watched widget's data, by widget id; dropped when no one watches it. */
  widgetData: Record<string, WidgetData>;
  /** Pending on you: open, answered, assumed and dismissed items. */
  pending: PendingItem[];
  pendingMarker: PendingMarker;
  /** The rlx service's settings (start at login, its tray icon), from the engine; null until read. */
  service: HostSettings | null;
}

/** A draft as an agent or widget proposes it; the core gives it an id, a time and its status. */
export type NewDraft = Omit<Draft, "id" | "createdAt" | "status">;

/** Settings any screen may change directly. Send modes go through `setSendMode` (the gate decides). */
export type SettingsPatch = Partial<Omit<Settings, "sendModes">>;

export interface Core {
  snapshot(): CoreSnapshot;
  /** Fires after every change; read `snapshot()` then. */
  subscribe(listener: () => void): Unsubscribe;
  /** What this window shows now (null: neither a channel nor Pending). */
  view(surface: Surface | null): void;
  /**
   * A widget is on screen: the core runs its data job (now, then on its interval) while anyone
   * watches it, and stops it, cancelling a refresh in flight, when the last watcher leaves.
   */
  watchWidget(widget: WidgetInstance): Unsubscribe;
  /** Stops following the engine and clears timers. */
  dispose(): void;

  // ---- settings ----------------------------------------------------------------------------
  /** Each key goes to its store: device keys to this device, the rest to the host. */
  updateSettings(patch: SettingsPatch): Promise<void>;
  /**
   * The only way to change a connector's send mode. Turning on Auto is the core's to confirm
   * (a native dialog in the real core); resolves whether the mode is now set.
   */
  setSendMode(connector: ConnectorId, mode: SendMode): Promise<boolean>;
  /** The rlx service's settings, written through the engine. */
  updateServiceSettings(patch: Partial<HostSettings>): Promise<void>;

  // ---- Home's widgets -----------------------------------------------------------------------
  addWidget(widget: WidgetInstance): Promise<void>;
  removeWidget(id: string): Promise<void>;
  moveWidget(id: string, to: number): Promise<void>;
  /** Refreshes a watched widget now. */
  refreshWidget(id: string): Promise<void>;

  // ---- agents and their schedule -------------------------------------------------------------
  /** Starts one run of the agent's job now, unless one is live. */
  wake(agentId: string): Promise<void>;
  setPaused(agentId: string, paused: boolean): Promise<void>;
  /** Saves an edited definition (name, connectors, schedule, mode, outputs). */
  editAgent(agentId: string, next: Proposal): Promise<void>;

  // ---- conversations -------------------------------------------------------------------------
  /** The owner says something in a channel (or the manager's DM); resolves when the reply is in. */
  sendMessage(channel: string, text: string): Promise<void>;
  /** Answers a needs-context card: the answer becomes a draft reply. */
  answerNeedsContext(messageId: string, answer: string): Promise<void>;
  /** Confirms a manager's proposal card: the agent is created and scheduled. */
  confirmProposal(messageId: string, proposal: Proposal): Promise<Agent>;
  cancelProposal(messageId: string): Promise<void>;

  // ---- drafts and the send gate --------------------------------------------------------------
  /** Resolves with the id the core gave it. */
  createDraft(draft: NewDraft): Promise<string>;
  editDraft(id: string, body: string): Promise<void>;
  discardDraft(id: string): Promise<void>;
  /** The owner approves it; it sends when they press Send. */
  approveDraft(id: string): Promise<void>;
  /** The owner approves it and it sends now. */
  approveAndSend(id: string): Promise<void>;
  /** Sends if the gate allows it now (approved, Pre-approved and covered), or holds it on Auto. */
  send(id: string): Promise<SendResult>;
  /** Stops Auto's hold; the draft waits again. */
  undoSend(id: string): Promise<void>;
  revokeApproval(id: string): Promise<void>;

  // ---- notifications ---------------------------------------------------------------------------
  dismissNotice(id: string): Promise<void>;

  // ---- Pending on you --------------------------------------------------------------------------
  /**
   * Answers an item: a suggested answer (`choice`) or free text. An approval is decided only by
   * an explicit choice; free text on one is kept as a note and never sends. Answering an
   * assumed item changes its answer (the manager redoes the dependent work).
   */
  answerPending(id: string, answer: PendingAnswer): Promise<void>;
  /** Keeps the manager's assumed answer. */
  confirmAssumed(id: string): Promise<void>;
  dismissPending(id: string): Promise<void>;
  /** The section was seen: the unread marker moves to the newest item. */
  markPendingSeen(): Promise<void>;
  setPendingMuted(muted: boolean): Promise<void>;
  setPendingEnabled(enabled: boolean): Promise<void>;
}
