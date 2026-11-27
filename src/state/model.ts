/**
 * The app's data model. Product state (settings, agents, conversations, drafts, approvals,
 * Pending) lives in the core (src/core/); the React tree keeps only navigation, toasts and the
 * About box.
 */
import type { CoreSnapshot } from "../core/types.ts";
import { GMAIL, LINEAR, SLACK, type ConnectorId } from "../core/connectors.ts";
import type { AccountChoice } from "../engine/types.ts";
import type { ThemeFamily } from "../theme/themes.ts";
import type { AgentMode, AgentOutput, Schedule } from "./agents.ts";

/**
 * Screens. The app is a chat app (owner, 2026-11-25): agents are channels, the manager is a
 * DM, and raw run logs show only in Developer mode ("runs").
 */
export type Screen =
  | { name: "home" }
  | { name: "agents" }
  | { name: "channel"; id: string }
  | { name: "approvals"; tab: "drafts" | "standing" | "activity" }
  | { name: "settings"; section?: "send-safety" | "appearance" | "agent" | "developer" | "about" }
  | { name: "runs"; runId?: string }
  | { name: "fleet" }
  | { name: "board" }
  | { name: "panes"; agentId?: string };

export type ScreenName = Screen["name"];

export type SendMode = "draft" | "preapproved" | "auto";
export type Density = "compact" | "default" | "spacious";
export type ThemeMode = "dark" | "light" | "system";
export type Accent = { kind: "theme" } | { kind: "preset"; id: string } | { kind: "custom"; hex: string };

export type WidgetType = "slack" | "gmail" | "clock" | "timer" | "pomodoro" | "generic" | "agent" | "ask";

export interface WidgetInstance {
  id: string;
  type: WidgetType;
  /** For "agent": the manifest title and the HTML an agent made. */
  title?: string;
  html?: string;
  /** For "generic": the connector it reads. */
  connector?: ConnectorId;
  /** Which Claude account its refreshes use; Auto when absent (task #23). */
  account?: AccountChoice;
  /** The agent whose silent run this widget shows; its refreshes record that agent's last run. */
  agentId?: string;
}

/**
 * The host's app settings: they live with the host's rlx and every device connected to it sees
 * the same values (owner brief, remote and multi-device §4: theme, layout, sign-off, send safety).
 */
export interface AppSettings {
  agentName: string;
  ownerName: string;
  family: ThemeFamily;
  mode: ThemeMode;
  accent: Accent;
  density: Density;
  /** Keyed by connector id. */
  sendModes: Record<ConnectorId, SendMode>;
  slackIntervalMin: number;
  keySenders: string[];
  /** Home's dashboard. */
  widgets: WidgetInstance[];
}

/** This device's own settings: they stay on this device (localStorage) and never reach the host. */
export interface DeviceSettings {
  /** This device has been through setup (a new device shows Welcome once, with the host's names filled in). */
  onboarded: boolean;
  devMode: boolean;
  /** The rlx home the local engine adapter uses; empty means the sandbox (~/.rlx-sandbox). */
  engineHome: string;
}

export const DEVICE_SETTING_KEYS = ["onboarded", "devMode", "engineHome"] as const satisfies readonly (keyof DeviceSettings)[];

/** Both, as one view for the screens; the core routes each key to its store. */
export type Settings = AppSettings & DeviceSettings;

export type DraftOrigin = "task" | "approval" | "widget" | "dataJob";

export interface Draft {
  id: string;
  /** pending → approved (the owner said yes) → held (Auto's 10 s hold) → sent. */
  status: "pending" | "approved" | "held";
  origin: DraftOrigin;
  connector: ConnectorId;
  destination: string;
  subject?: string;
  /** The body the agent wrote; the core appends the sign-off when it sends. */
  body: string;
  createdAt: number;
  context: string;
}

export interface StandingApproval {
  id: string;
  instruction: string;
  connector: ConnectorId;
  destination: string;
  trigger: string;
  expiry: "once" | "untilRevoked";
  maxChars: number;
  status: "active" | "revoked" | "used";
  confirmedAt: number;
}

export interface ActivityItem {
  id: string;
  at: number;
  connector: ConnectorId;
  destination: string;
  subject?: string;
  body: string;
  signOff: string;
  approvedBy: "owner" | "standing approval" | "auto";
}

/** A link back to the message an item came from. */
export interface SourceLink {
  label: string;
  connector: ConnectorId;
  url: string;
}

export interface PriorityItem {
  id: string;
  text: string;
  why?: string;
  sources: SourceLink[];
}

export interface Proposal {
  role?: "briefing";
  purpose: string;
  name: string;
  connectors: ConnectorId[];
  schedule: Schedule;
  mode: AgentMode;
  outputs: AgentOutput[];
}

/** Rich message cards: what a non-developer sees instead of tool logs. */
export type Card =
  | { type: "email-draft"; draftId: string }
  | {
      type: "needs-context";
      id: string;
      question: string;
      to: string;
      subject: string;
      connector: ConnectorId;
      sources: SourceLink[];
      /** The reply draft, with the owner's answer in place of `{answer}`. */
      draftTemplate: string;
      answered?: string;
    }
  | { type: "checklist"; title: string; items: { text: string; done: boolean }[] }
  | { type: "priority"; title: string; doNow: PriorityItem[]; today: PriorityItem[]; waiting: PriorityItem[] }
  | { type: "promise"; text: string; due: string; meeting: string; sources: SourceLink[] }
  | { type: "proposal"; id: string; proposal: Proposal; status: "proposed" | "confirmed" | "cancelled" };

export interface Message {
  id: string;
  /** An agent id, or "manager" for the setup assistant's DM. */
  channel: string;
  /** "system" lines are run outcomes ("Woke · fetched, nothing new"); they don't count as unread. */
  from: "owner" | "agent" | "system";
  at: number;
  text?: string;
  card?: Card;
  /** An agent's reply still streaming in; screen readers hear it once it's final. */
  streaming?: boolean;
}

/** A mock system notification, as a loud run would fire. */
export interface Notice {
  id: string;
  title: string;
  body: string;
  channel: string;
}

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "success" | "warning" | "error";
}

/** What only this window knows: where it is, its toasts, and whether About is open. */
export interface UiState {
  history: Screen[];
  index: number;
  toasts: Toast[];
  aboutOpen: boolean;
}

/** What the screens read: the core's snapshot plus the window's own state. */
export type AppState = CoreSnapshot & UiState;

/** The connectors Settings › Send safety lists. */
export const CONNECTOR_NAMES: readonly ConnectorId[] = [SLACK, GMAIL, LINEAR];

export const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-slack", type: "slack", agentId: "slack-agent" },
  { id: "w-gmail", type: "gmail", agentId: "gmail-agent" },
  { id: "w-clock", type: "clock" },
  { id: "w-pomodoro", type: "pomodoro" },
  { id: "w-timer", type: "timer" },
  { id: "w-linear", type: "generic", connector: LINEAR },
  { id: "w-prs", type: "agent", title: "Open pull requests" },
  { id: "w-ask", type: "ask" },
];

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  agentName: "Nova",
  ownerName: "Sam Rivera",
  family: "rlx",
  mode: "dark",
  accent: { kind: "theme" },
  density: "default",
  devMode: false,
  sendModes: { [SLACK]: "draft", [GMAIL]: "draft", [LINEAR]: "draft" },
  slackIntervalMin: 15,
  engineHome: "",
  keySenders: ["Tom Okafor", "Lena Fischer", "Board Office"],
  widgets: DEFAULT_WIDGETS,
};

/**
 * The sign-off the core appends to every send: `— <Agent>, <Owner>'s AI Agent`. `<Agent>` is
 * ALWAYS the owner's personal agent (Settings › Your agent), whichever helper agent (Start of
 * day, the Slack agent, …) drafted the message (owner decision, 2026-11-25).
 */
export function signOffText(agentName: string, ownerName: string): string {
  return `— ${agentName || "Your agent"}, ${ownerName || "you"}'s AI Agent`;
}

export function screenTitle(screen: Screen): string {
  switch (screen.name) {
    case "home":
      return "Home";
    case "agents":
      return "Agents";
    case "channel":
      return "Chat";
    case "approvals":
      return "Approvals";
    case "runs":
      return "Runs";
    case "settings":
      return "Settings";
    case "fleet":
      return "Fleet";
    case "board":
      return "Board";
    case "panes":
      return "Panes";
  }
}
