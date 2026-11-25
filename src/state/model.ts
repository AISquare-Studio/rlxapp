/** The app's own state: settings, the mock core's drafts and approvals, and navigation. */
import type { ThemeFamily } from "../theme/themes.ts";

export type Screen =
  | { name: "home" }
  | { name: "tasks"; runId?: string }
  | { name: "approvals"; tab: "drafts" | "standing" | "activity" }
  | { name: "chat" }
  | { name: "settings"; section?: "send-safety" | "appearance" | "agent" | "developer" | "about" }
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
  connector?: string;
}

export interface Settings {
  onboarded: boolean;
  agentName: string;
  ownerName: string;
  family: ThemeFamily;
  mode: ThemeMode;
  accent: Accent;
  density: Density;
  devMode: boolean;
  sendModes: Record<string, SendMode>;
  slackIntervalMin: number;
  keySenders: string[];
  widgets: WidgetInstance[];
}

export type DraftOrigin = "task" | "approval" | "widget" | "dataJob";

export interface Draft {
  id: string;
  origin: DraftOrigin;
  connector: string;
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
  connector: string;
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
  connector: string;
  destination: string;
  subject?: string;
  body: string;
  signOff: string;
  approvedBy: "owner" | "standing approval" | "auto";
}

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "success" | "warning" | "error";
}

export interface AppState {
  settings: Settings;
  history: Screen[];
  index: number;
  drafts: Draft[];
  approvals: StandingApproval[];
  activity: ActivityItem[];
  toasts: Toast[];
  aboutOpen: boolean;
  rightPanel: boolean;
}

export const CONNECTOR_NAMES = ["claude.ai Slack", "claude.ai Gmail", "claude.ai Linear"] as const;

export const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-slack", type: "slack" },
  { id: "w-gmail", type: "gmail" },
  { id: "w-clock", type: "clock" },
  { id: "w-pomodoro", type: "pomodoro" },
  { id: "w-timer", type: "timer" },
  { id: "w-linear", type: "generic", connector: "claude.ai Linear" },
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
  sendModes: { "claude.ai Slack": "draft", "claude.ai Gmail": "draft", "claude.ai Linear": "draft" },
  slackIntervalMin: 15,
  keySenders: ["Tom Okafor", "Lena Fischer", "Board Office"],
  widgets: DEFAULT_WIDGETS,
};

/** The sign-off the core appends to every send: `— <Agent>, <Owner>'s AI Agent`. */
export function signOffText(agentName: string, ownerName: string): string {
  return `— ${agentName || "Your agent"}, ${ownerName || "you"}'s AI Agent`;
}

export function screenTitle(screen: Screen): string {
  switch (screen.name) {
    case "home":
      return "Home";
    case "tasks":
      return "Tasks";
    case "approvals":
      return "Approvals";
    case "chat":
      return "Chat";
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
