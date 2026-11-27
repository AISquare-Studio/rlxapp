/**
 * The Core interface: the app core the screens talk to (architecture §2: scheduler, send gate,
 * storage). It owns the product state: settings, agents and their runs' outcomes, conversations,
 * drafts, standing approvals, activity, notifications and Pending. The engine (rlxd) does the
 * agentic work underneath; the React tree keeps only navigation and toasts.
 *
 * Storage: the host's app settings and data go to the host (rlxd's settings API, handoff
 * addendum §4), so every device on that host sees them; device-local settings stay in this
 * device's storage. `FakeCore` (./fake/) implements this in memory over any `Engine`.
 */
import type { HostSettings, Unsubscribe } from "../engine/types.ts";
import type { Agent, AgentRun } from "../state/agents.ts";
import type { ActivityItem, Card, Draft, Message, Notice, Proposal, Settings, StandingApproval, WidgetInstance } from "../state/model.ts";
import type { SendResult } from "./gate.ts";
import type { PendingItem, PendingMarker } from "./pending.ts";

/** What a window has on screen, so what it shows isn't counted unread. */
export type Surface = { kind: "channel"; id: string } | { kind: "pending" };

export type PriorityCard = Extract<Card, { type: "priority" }>;

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
  /** Pending on you: open, answered, assumed and dismissed items. */
  pending: PendingItem[];
  pendingMarker: PendingMarker;
  /** The rlx service's settings (start at login, its tray icon), from the engine; null until read. */
  service: HostSettings | null;
}

/** A draft as an agent or widget proposes it; the core gives it an id, a time and its status. */
export type NewDraft = Omit<Draft, "id" | "createdAt" | "status">;

export interface Core {
  snapshot(): CoreSnapshot;
  /** Fires after every change; read `snapshot()` then. */
  subscribe(listener: () => void): Unsubscribe;
  /** What this window shows now (null: neither a channel nor Pending). */
  view(surface: Surface | null): void;

  // ---- settings ----------------------------------------------------------------------------
  /** Each key goes to its store: device keys stay on this device, the rest go to the host. */
  updateSettings(patch: Partial<Settings>): void;
  /** The rlx service's settings, written through the engine. */
  updateServiceSettings(patch: Partial<HostSettings>): Promise<void>;

  // ---- Home's widgets -----------------------------------------------------------------------
  addWidget(widget: WidgetInstance): void;
  removeWidget(id: string): void;
  moveWidget(id: string, to: number): void;

  // ---- agents and their schedule -------------------------------------------------------------
  /** Starts one run of the agent's job now, unless one is live. */
  wake(agentId: string): Promise<void>;
  setPaused(agentId: string, paused: boolean): void;
  /** Saves an edited definition (name, connectors, schedule, mode, outputs). */
  editAgent(agentId: string, next: Proposal): void;
  /** Records an outcome a widget's refresh produced for its agent. */
  recordAgentRun(agentId: string, run: AgentRun): void;

  // ---- conversations -------------------------------------------------------------------------
  /** The owner says something in a channel (or the manager's DM); resolves when the reply is in. */
  sendMessage(channel: string, text: string): Promise<void>;
  /** Answers a needs-context card: the answer becomes a draft reply. */
  answerNeedsContext(messageId: string, answer: string): void;
  /** Confirms a manager's proposal card: the agent is created and scheduled. */
  confirmProposal(messageId: string, proposal: Proposal): Agent;
  cancelProposal(messageId: string): void;

  // ---- drafts and the send gate --------------------------------------------------------------
  createDraft(draft: NewDraft): string;
  editDraft(id: string, body: string): void;
  discardDraft(id: string): void;
  /** The owner approves it; it sends when they press Send. */
  approveDraft(id: string): void;
  /** The owner approves it and it sends now. */
  approveAndSend(id: string): void;
  /** Sends if the gate allows it now (approved, Pre-approved and covered), or holds it on Auto. */
  send(id: string): SendResult;
  /** Stops Auto's hold; the draft waits again. */
  undoSend(id: string): void;
  revokeApproval(id: string): void;

  // ---- notifications ---------------------------------------------------------------------------
  dismissNotice(id: string): void;

  // ---- Pending on you --------------------------------------------------------------------------
  /** Delivers the answer to whoever asked, and the item leaves Open. */
  answerPending(id: string, answer: string): Promise<void>;
  dismissPending(id: string): void;
  /** The section was seen: the unread marker moves to the newest item. */
  markPendingSeen(): void;
  setPendingMuted(muted: boolean): void;
  setPendingEnabled(enabled: boolean): void;

  /** Stops following the engine and clears timers. */
  dispose(): void;
}
