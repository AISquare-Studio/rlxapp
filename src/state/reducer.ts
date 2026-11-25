import { MANAGER_ID, seedAgents, type Agent } from "./agents.ts";
import {
  DEFAULT_SETTINGS,
  signOffText,
  type ActivityItem,
  type AppState,
  type Card,
  type Draft,
  type Message,
  type Notice,
  type Screen,
  type Settings,
  type StandingApproval,
  type Toast,
  type WidgetInstance,
} from "./model.ts";

export const STORAGE_KEY = "rlx.settings.v1";

export type Action =
  | { type: "navigate"; screen: Screen }
  | { type: "back" }
  | { type: "forward" }
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "widget-add"; widget: WidgetInstance }
  | { type: "widget-remove"; id: string }
  | { type: "widget-move"; id: string; to: number }
  | { type: "draft-create"; draft: Draft }
  | { type: "draft-edit"; id: string; body: string }
  | { type: "draft-discard"; id: string }
  | { type: "draft-approve"; id: string; at: number }
  | { type: "approval-revoke"; id: string }
  | { type: "toast"; toast: Toast }
  | { type: "toast-dismiss"; id: string }
  | { type: "draft-status"; id: string; status: Draft["status"] }
  | { type: "draft-send"; id: string; at: number; approvedBy: ActivityItem["approvedBy"] }
  | { type: "agent-add"; agent: Agent }
  | { type: "agent-update"; id: string; patch: Partial<Agent> }
  | { type: "message-add"; message: Message }
  | { type: "message-card"; id: string; card: Card }
  | { type: "message-append"; id: string; text: string }
  | { type: "briefing"; at: number; card: Extract<Card, { type: "priority" }> }
  | { type: "notice"; notice: Notice }
  | { type: "notice-dismiss"; id: string }
  | { type: "about"; open: boolean }
  | { type: "right-panel"; open: boolean }
  | { type: "home-panel"; open: boolean };

function sameScreen(a: Screen | undefined, b: Screen): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "navigate": {
      if (sameScreen(state.history[state.index], action.screen)) return state;
      const history = [...state.history.slice(0, state.index + 1), action.screen].slice(-50);
      return markRead({ ...state, history, index: history.length - 1 });
    }
    case "back":
      return state.index > 0 ? markRead({ ...state, index: state.index - 1 }) : state;
    case "forward":
      return state.index < state.history.length - 1 ? markRead({ ...state, index: state.index + 1 }) : state;
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case "widget-add":
      return { ...state, settings: { ...state.settings, widgets: [...state.settings.widgets, action.widget] } };
    case "widget-remove":
      return {
        ...state,
        settings: { ...state.settings, widgets: state.settings.widgets.filter((w) => w.id !== action.id) },
      };
    case "widget-move": {
      const widgets = [...state.settings.widgets];
      const from = widgets.findIndex((w) => w.id === action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(widgets.length - 1, action.to));
      const [moved] = widgets.splice(from, 1);
      if (moved) widgets.splice(to, 0, moved);
      return { ...state, settings: { ...state.settings, widgets } };
    }
    case "draft-create":
      return { ...state, drafts: [action.draft, ...state.drafts] };
    case "draft-edit":
      return { ...state, drafts: state.drafts.map((d) => (d.id === action.id ? { ...d, body: action.body } : d)) };
    case "draft-discard":
      return { ...state, drafts: state.drafts.filter((d) => d.id !== action.id) };
    case "draft-approve":
      return send(state, action.id, action.at, "owner");
    case "draft-send":
      return send(state, action.id, action.at, action.approvedBy);
    case "draft-status":
      return { ...state, drafts: state.drafts.map((d) => (d.id === action.id ? { ...d, status: action.status } : d)) };
    case "agent-add":
      return { ...state, settings: { ...state.settings, agents: [...state.settings.agents, action.agent] } };
    case "agent-update":
      return {
        ...state,
        settings: {
          ...state.settings,
          agents: state.settings.agents.map((a) => (a.id === action.id ? { ...a, ...action.patch } : a)),
        },
      };
    case "message-add": {
      const current = state.history[state.index];
      const here = current?.name === "channel" && current.id === action.message.channel;
      const unread = action.message.from === "agent" && !here ? { ...state.unread, [action.message.channel]: (state.unread[action.message.channel] ?? 0) + 1 } : state.unread;
      return { ...state, messages: [...state.messages, action.message], unread };
    }
    case "message-append":
      return { ...state, messages: state.messages.map((m) => (m.id === action.id ? { ...m, text: (m.text ?? "") + action.text } : m)) };
    case "message-card":
      return { ...state, messages: state.messages.map((m) => (m.id === action.id ? { ...m, card: action.card } : m)) };
    case "briefing":
      return { ...state, briefing: { at: action.at, card: action.card } };
    case "notice":
      return { ...state, notices: [...state.notices, action.notice].slice(-3) };
    case "notice-dismiss":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    case "approval-revoke":
      return {
        ...state,
        approvals: state.approvals.map((a) => (a.id === action.id ? { ...a, status: "revoked" } : a)),
      };
    case "toast":
      return { ...state, toasts: [...state.toasts, action.toast].slice(-3) };
    case "toast-dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "about":
      return { ...state, aboutOpen: action.open };
    case "right-panel":
      return { ...state, rightPanel: action.open };
    case "home-panel":
      return { ...state, homePanel: action.open };
  }
}

export function loadSettings(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Opening a channel marks its messages read. */
function markRead(state: AppState): AppState {
  const screen = state.history[state.index];
  if (screen?.name !== "channel" || !state.unread[screen.id]) return state;
  return { ...state, unread: { ...state.unread, [screen.id]: 0 } };
}

/** Sends a draft: it leaves the queue and enters the activity log with the sign-off. */
function send(state: AppState, id: string, at: number, approvedBy: ActivityItem["approvedBy"]): AppState {
  const draft = state.drafts.find((d) => d.id === id);
  if (!draft) return state;
  const item: ActivityItem = {
    id: `act-${draft.id}`,
    at,
    connector: draft.connector,
    destination: draft.destination,
    subject: draft.subject,
    body: draft.body,
    signOff: signOffText(state.settings.agentName, state.settings.ownerName),
    approvedBy,
  };
  return { ...state, drafts: state.drafts.filter((d) => d.id !== id), activity: [item, ...state.activity] };
}

const HOUR = 3_600_000;

export function initialState(settings: Settings, now: number): AppState {
  const drafts: Draft[] = [
    {
      id: "d-seed-1",
      status: "pending",
      origin: "task",
      connector: "claude.ai Slack",
      destination: "#launch",
      body: "I can own the press kit. I'll have a first version in this channel by Thursday.",
      createdAt: now - HOUR / 2,
      context: "From the task “Triage my inbox and draft replies”",
    },
  ];
  const approvals: StandingApproval[] = [
    {
      id: "apr-ci-green",
      instruction: "When CI on main is green, post in #dev asking for approval to deploy.",
      connector: "claude.ai Slack",
      destination: "#dev",
      trigger: "When CI on main reports success",
      expiry: "once",
      maxChars: 280,
      status: "active",
      confirmedAt: now - 3 * HOUR,
    },
    {
      id: "apr-slots",
      instruction: "Answer Priya's meeting-time questions with my free slots.",
      connector: "claude.ai Slack",
      destination: "DM with Priya Shah",
      trigger: "When Priya asks for a meeting time",
      expiry: "untilRevoked",
      maxChars: 200,
      status: "active",
      confirmedAt: now - 26 * HOUR,
    },
  ];
  const activity: ActivityItem[] = [
    {
      id: "act-seed-1",
      at: now - 5 * HOUR,
      connector: "claude.ai Gmail",
      destination: "Finance Team",
      subject: "Re: Expense report",
      body: "Thanks, the receipts are attached. Let me know if anything is missing.",
      signOff: signOffText(settings.agentName, settings.ownerName),
      approvedBy: "owner",
    },
  ];
  const messages: Message[] = [
    {
      id: "m-manager-hello",
      channel: MANAGER_ID,
      from: "agent",
      at: now - 2 * HOUR,
      text: `Hi ${settings.ownerName.split(" ")[0] ?? ""}, I set up your agents. Tell me what you want done and when, and I'll propose an agent for it. Try: “Every weekday at 9, give me a start of day briefing.”`,
    },
  ];
  return {
    settings: settings.agents.length ? settings : { ...settings, agents: seedAgents(now) },
    history: [{ name: "home" }],
    index: 0,
    drafts,
    approvals,
    activity,
    toasts: [],
    aboutOpen: false,
    rightPanel: true,
    messages,
    briefing: null,
    notices: [],
    unread: {},
    homePanel: false,
  };
}

