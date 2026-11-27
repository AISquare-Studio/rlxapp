import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { APP_HOMEPAGE_URL } from "../brand/homepage.ts";
import { RlxMark } from "../brand/RlxMark.tsx";
import { useRunningAgents } from "../agents/useAgents.ts";
import { useNow } from "../engine/hooks.ts";
import type { EngineStatus } from "../engine/types.ts";
import { MANAGER_ID, agentStatus, wakeLabel, type AgentStatus } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import { screenTitle, type Screen, type ScreenName } from "../state/model.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";

const DEV_SCREENS = new Set<ScreenName>(["runs", "fleet", "board", "panes"]);

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 380;

/**
 * The window is a 2-way split (owner amendment 4): the left pane (navigation and the agents
 * list) and the centre (the selected item's screen, with its slim navigation line on top).
 * Exactly one vertical divider, between the two; no rail and no right-hand column.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { state, screen, dispatch } = useApp();
  const [sidebar, setSidebar] = useState(256);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft") dispatch({ type: "back" });
      if (event.altKey && event.key === "ArrowRight") dispatch({ type: "forward" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const start = sidebar;
    const move = (e: PointerEvent) => setSidebar(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, start + e.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setSidebar((w) => Math.max(MIN_SIDEBAR, w - 16));
    if (event.key === "ArrowRight") setSidebar((w) => Math.min(MAX_SIDEBAR, w + 16));
  };

  return (
    <div className="shell">
      <TitleBar />
      <div className="shell__body" data-testid="shell-body">
        <div className="sidebar-column" style={{ width: sidebar }} data-pane="left">
          <nav className="sidebar" aria-label="Navigation">
            <LeftPane />
          </nav>
          <AgentPanel />
        </div>
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the left pane"
          aria-valuemin={MIN_SIDEBAR}
          aria-valuemax={MAX_SIDEBAR}
          aria-valuenow={sidebar}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
        <main className={`main${screen.name === "channel" ? " main--chat" : ""}`} id="main" aria-label={screenTitle(screen)} data-pane="centre">
          {children}
        </main>
      </div>
      <Notices />
      <Toasts />
      {state.aboutOpen ? <AboutDialog /> : null}
    </div>
  );
}

/** The window's top strip: the mark, back/forward and About. Where-you-are lives in the centre. */
function TitleBar() {
  const { state, dispatch } = useApp();
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <RlxMark className="titlebar__mark" />
      </div>
      <div className="titlebar__nav">
        <button type="button" className="icon-button" aria-label="Back" disabled={state.index === 0} onClick={() => dispatch({ type: "back" })}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-button" aria-label="Forward" disabled={state.index >= state.history.length - 1} onClick={() => dispatch({ type: "forward" })}>
          <Icon name="forward" />
        </button>
      </div>
      <div className="titlebar__spacer" />
      <div className="titlebar__tools">
        <button type="button" className="icon-button" aria-label="About rlx" onClick={() => dispatch({ type: "about", open: true })}>
          <Icon name="info" />
        </button>
      </div>
    </header>
  );
}

function SideLink({
  active,
  onClick,
  children,
  label,
  describedBy,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
  describedBy?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className={`side-link reveal-host${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        aria-describedby={describedBy}
        onClick={onClick}
      >
        {children}
      </button>
    </li>
  );
}

/** The next wake, short enough to sit beside the name; revealed on hover and keyboard focus. */
function shortStatus(status: AgentStatus, now: number): string {
  if (status.kind === "running") return "running now";
  if (status.next === undefined) return status.label.toLowerCase();
  return `wakes ${wakeLabel(status.next, now)}`;
}

/** A dot, never a count (calm): something here is new or waiting. */
function Dot({ label }: { label: string }) {
  return <span className="dot-badge dot-badge--inline side-link__end" role="img" aria-label={label} />;
}

/** The left pane, the same on every screen: where to go, then the agents (Manager first). */
function LeftPane() {
  const { screen, navigate, state } = useApp();
  const running = useRunningAgents();
  const now = useNow(30_000);
  const { devMode } = state.settings;
  const { agents } = state;
  const here = (id: string) => screen.name === "channel" && screen.id === id;
  const drafts = state.drafts.length;
  const items: { name: ScreenName; label: string; icon: IconName; screen: Screen; dot?: string; active: boolean }[] = [
    { name: "home", label: "Dashboard", icon: "home", screen: { name: "home" }, active: screen.name === "home" },
    { name: "agents", label: "Agents", icon: "fleet", screen: { name: "agents" }, active: screen.name === "agents" },
    {
      name: "approvals",
      label: "Approvals",
      icon: "inbox",
      screen: { name: "approvals", tab: "drafts" },
      dot: drafts ? `${drafts} waiting` : undefined,
      active: screen.name === "approvals",
    },
    { name: "settings", label: "Settings", icon: "settings", screen: { name: "settings" }, active: screen.name === "settings" },
    ...(devMode
      ? [{ name: "runs" as const, label: "Developer", icon: "terminal" as const, screen: { name: "runs" } as Screen, active: DEV_SCREENS.has(screen.name) }]
      : []),
  ];
  return (
    <>
      <div className="space-header">
        <strong>{state.settings.ownerName.split(" ")[0] ?? ""}'s space</strong>
      </div>
      <ul className="side-list">
        {items.map((item) => (
          <SideLink key={item.name} active={item.active} onClick={() => navigate(item.screen)} label={item.dot ? `${item.label}, ${item.dot}` : item.label}>
            <Icon name={item.icon} size={16} /> {item.label}
            {item.dot ? <Dot label={item.dot} /> : null}
          </SideLink>
        ))}
      </ul>
      <div className="sidebar__heading-row">
        <h2 className="sidebar__title">Agents</h2>
        <button type="button" className="icon-button icon-button--sm" aria-label="Create an agent with the manager" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <ul className="side-list" aria-label="Agent channels">
        <SideLink active={here(MANAGER_ID)} onClick={() => navigate({ name: "channel", id: MANAGER_ID })} label="Manager, setup assistant">
          <Avatar letter="r" manager />
          <span className="side-link__row">
            <span className="side-link__text">Manager</span>
          </span>
          <Unread id={MANAGER_ID} />
        </SideLink>
        {agents.map((agent) => {
          const status = agentStatus(agent, running.has(agent.id), now);
          return (
            <SideLink
              key={agent.id}
              active={here(agent.id)}
              onClick={() => navigate({ name: "channel", id: agent.id })}
              label={`${agent.name}, ${status.label}`}
              describedBy={`wake-${agent.id}`}
            >
              <Avatar letter={agent.avatar} status={status.kind} />
              <span className="side-link__row">
                <span className="side-link__text">{agent.name}</span>
                <span className="muted side-link__sub reveal" id={`wake-${agent.id}`} data-testid={`status-${agent.id}`}>
                  {shortStatus(status, now)}
                </span>
              </span>
              <Unread id={agent.id} />
            </SideLink>
          );
        })}
      </ul>
    </>
  );
}

function Unread({ id }: { id: string }) {
  const { state } = useApp();
  const count = state.unread[id] ?? 0;
  return count ? <Dot label={`${count} unread`} /> : null;
}

function AgentPanel() {
  const { state, engine, navigate } = useApp();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    let active = true;
    void engine.status().then((next) => active && setStatus(next));
    return () => {
      active = false;
    };
  }, [engine]);
  const ready = status?.kind === "ready";
  return (
    <div className="agent-panel" aria-label="Your agent">
      <div className="agent-panel__avatar" aria-hidden="true">
        {(state.settings.agentName[0] ?? "N").toUpperCase()}
      </div>
      <div className="agent-panel__text">
        <strong>{state.settings.agentName}</strong>
        <span className="muted">
          <span className={`dot ${ready ? "dot--live" : "dot--warn"}`} aria-hidden="true" /> {ready ? `Working for ${state.settings.ownerName}` : "Claude Code not ready"}
        </span>
      </div>
      <button type="button" className="icon-button" aria-label="Agent settings" onClick={() => navigate({ name: "settings", section: "agent" })}>
        <Icon name="gear" />
      </button>
    </div>
  );
}

/** Mock system notifications, as a loud run fires them. */
function Notices() {
  const { state, core, navigate } = useApp();
  if (!state.notices.length) return null;
  return (
    <div className="notices" aria-live="assertive">
      {state.notices.map((n) => (
        <div key={n.id} className="notice" role="alert" aria-label={`Notification: ${n.title}`}>
          <div className="notice__app">
            <RlxMark className="notice__mark" /> rlx <span className="muted">· now · mock notification</span>
          </div>
          <strong className="notice__title">{n.title}</strong>
          <p className="notice__body">{n.body}</p>
          <div className="button-row">
            <button
              type="button"
              className="button button--sm button--primary"
              onClick={() => {
                core.dismissNotice(n.id);
                navigate({ name: "channel", id: n.channel });
              }}
            >
              Open
            </button>
            <button type="button" className="button button--sm" onClick={() => core.dismissNotice(n.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Toasts() {
  const { state, dispatch } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`} role="status">
          <span>{t.text}</span>
          <button type="button" className="icon-button icon-button--sm" aria-label="Dismiss" onClick={() => dispatch({ type: "toast-dismiss", id: t.id })}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function AboutDialog() {
  const { dispatch, platform } = useApp();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void platform.appInfo().then((info) => setVersion(`${info.version}${info.runtime === "browser" ? " · browser preview" : ` · ${info.os} (${info.arch})`}`));
  }, [platform]);
  return (
    <Modal title="About rlx" onClose={() => dispatch({ type: "about", open: false })}>
      <div className="about">
        <RlxMark className="about__mark" />
        <p className="about__name">rlx</p>
        <p className="muted" data-testid="about-version">
          Version {version}
        </p>
        <p>Your AI agent, running in the background on rlx and Claude Code.</p>
        <p>
          <a href={APP_HOMEPAGE_URL} target="_blank" rel="noreferrer">
            Homepage
          </a>
        </p>
      </div>
    </Modal>
  );
}
