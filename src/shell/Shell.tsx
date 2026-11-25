import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { APP_HOMEPAGE_URL } from "../brand/homepage.ts";
import { RlxMark } from "../brand/RlxMark.tsx";
import { useRuns } from "../engine/hooks.ts";
import { STATE_LABEL, taskRuns } from "../engine/runs.ts";
import type { EngineStatus } from "../engine/types.ts";
import { StateChip } from "../screens/Tasks.tsx";
import { useApp } from "../state/context.ts";
import { screenTitle, type Screen, type ScreenName } from "../state/model.ts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";

interface NavItem {
  name: ScreenName;
  label: string;
  icon: IconName;
  screen: Screen;
}

const MAIN_NAV: NavItem[] = [
  { name: "home", label: "Home", icon: "home", screen: { name: "home" } },
  { name: "tasks", label: "Tasks", icon: "tasks", screen: { name: "tasks" } },
  { name: "approvals", label: "Approvals", icon: "inbox", screen: { name: "approvals", tab: "drafts" } },
  { name: "chat", label: "Chat", icon: "chat", screen: { name: "chat" } },
];

const DEV_NAV: NavItem[] = [
  { name: "fleet", label: "Fleet", icon: "fleet", screen: { name: "fleet" } },
  { name: "board", label: "Board", icon: "board", screen: { name: "board" } },
  { name: "panes", label: "Panes", icon: "panes", screen: { name: "panes" } },
];

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 380;

export function Shell({ children }: { children: ReactNode }) {
  const { state, screen, dispatch } = useApp();
  const [sidebar, setSidebar] = useState(240);

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
      <div className="shell__body">
        <IconRail />
        <nav className="sidebar" style={{ width: sidebar }} aria-label={`${screenTitle(screen)} navigation`}>
          <Sidebar />
        </nav>
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          aria-valuemin={MIN_SIDEBAR}
          aria-valuemax={MAX_SIDEBAR}
          aria-valuenow={sidebar}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
        <main className="main" id="main" aria-label={screenTitle(screen)}>
          {children}
        </main>
        {state.rightPanel ? <RightPanel /> : null}
      </div>
      <AgentPanel />
      <Toasts />
      {state.aboutOpen ? <AboutDialog /> : null}
    </div>
  );
}

function TitleBar() {
  const { state, screen, dispatch, navigate } = useApp();
  const runs = useRuns();
  const needsYou = taskRuns(runs).filter((r) => r.state === "needs-you").length;
  const inbox = state.drafts.length + needsYou;
  const crumbs: string[] = [screenTitle(screen)];
  if (screen.name === "tasks" && screen.runId) crumbs.push(runs.find((r) => r.id === screen.runId)?.title ?? "Task");
  if (screen.name === "approvals") crumbs.push({ drafts: "Drafts", standing: "Standing approvals", activity: "Activity" }[screen.tab]);
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
      <p className="titlebar__where" aria-label="Where you are">
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`}>
            {i > 0 ? <span className="titlebar__sep"> › </span> : null}
            <span className={i === crumbs.length - 1 ? "titlebar__here" : ""}>{c}</span>
          </span>
        ))}
      </p>
      <div className="titlebar__tools">
        <button
          type="button"
          className="icon-button titlebar__inbox"
          aria-label={`Approvals inbox, ${inbox} waiting`}
          onClick={() => navigate({ name: "approvals", tab: "drafts" })}
        >
          <Icon name="inbox" />
          {inbox > 0 ? <span className="badge-count" data-testid="inbox-count">{inbox}</span> : null}
        </button>
        <button
          type="button"
          className={`icon-button${state.rightPanel ? " is-active" : ""}`}
          aria-label="Needs-you panel"
          aria-pressed={state.rightPanel}
          onClick={() => dispatch({ type: "right-panel", open: !state.rightPanel })}
        >
          <Icon name="panel" />
        </button>
        <button type="button" className="icon-button" aria-label="About rlx" onClick={() => dispatch({ type: "about", open: true })}>
          <Icon name="info" />
        </button>
      </div>
    </header>
  );
}

function RailButton({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const { navigate } = useApp();
  return (
    <button
      type="button"
      className={`rail__button${active ? " is-active" : ""}`}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={item.label}
      onClick={() => navigate(item.screen)}
    >
      <Icon name={item.icon} size={20} />
      {badge ? <span className="badge-count badge-count--rail">{badge}</span> : null}
    </button>
  );
}

function IconRail() {
  const { state, screen } = useApp();
  const runs = taskRuns(useRuns());
  const needsYou = runs.filter((r) => r.state === "needs-you").length;
  return (
    <nav className="rail" aria-label="Sections">
      {MAIN_NAV.map((item) => (
        <RailButton
          key={item.name}
          item={item}
          active={screen.name === item.name}
          badge={item.name === "approvals" ? state.drafts.length : item.name === "tasks" ? needsYou : undefined}
        />
      ))}
      {state.settings.devMode ? (
        <div className="rail__group" role="group" aria-label="Developer">
          <span className="rail__divider" aria-hidden="true" />
          {DEV_NAV.map((item) => (
            <RailButton key={item.name} item={item} active={screen.name === item.name} />
          ))}
        </div>
      ) : null}
      <div className="rail__spacer" />
      <RailButton item={{ name: "settings", label: "Settings", icon: "settings", screen: { name: "settings" } }} active={screen.name === "settings"} />
    </nav>
  );
}

function SideLink({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <li>
      <button type="button" className={`side-link${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
        {children}
      </button>
    </li>
  );
}

function Sidebar() {
  const { screen, navigate, state } = useApp();
  const runs = taskRuns(useRuns());
  switch (screen.name) {
    case "home":
      return (
        <>
          <h2 className="sidebar__title">Dashboards</h2>
          <ul className="side-list">
            <SideLink active onClick={() => navigate({ name: "home" })}>
              My dashboard
            </SideLink>
          </ul>
          <h2 className="sidebar__title">Connectors</h2>
          <ul className="side-list side-list--static">
            {["Slack", "Gmail", "Linear"].map((c) => (
              <li key={c} className="side-item">
                <span className="dot dot--live" aria-hidden="true" /> {c}
              </li>
            ))}
            <li className="side-item">
              <span className="dot dot--warn" aria-hidden="true" /> Calendar <span className="muted">· needs sign-in</span>
            </li>
          </ul>
        </>
      );
    case "tasks":
      return (
        <>
          <h2 className="sidebar__title">Tasks</h2>
          <ul className="side-list">
            <SideLink active={!screen.runId} onClick={() => navigate({ name: "tasks" })}>
              All tasks
            </SideLink>
            {runs.map((run) => (
              <SideLink key={run.id} active={screen.runId === run.id} onClick={() => navigate({ name: "tasks", runId: run.id })}>
                <span className={`dot dot--${run.state}`} aria-label={STATE_LABEL[run.state]} />
                <span className="side-link__text">{run.title}</span>
              </SideLink>
            ))}
          </ul>
        </>
      );
    case "approvals":
      return (
        <>
          <h2 className="sidebar__title">Approvals</h2>
          <ul className="side-list">
            <SideLink active={screen.tab === "drafts"} onClick={() => navigate({ name: "approvals", tab: "drafts" })}>
              Drafts <span className="muted">{state.drafts.length}</span>
            </SideLink>
            <SideLink active={screen.tab === "standing"} onClick={() => navigate({ name: "approvals", tab: "standing" })}>
              Standing approvals
            </SideLink>
            <SideLink active={screen.tab === "activity"} onClick={() => navigate({ name: "approvals", tab: "activity" })}>
              Activity
            </SideLink>
          </ul>
        </>
      );
    case "chat":
      return (
        <>
          <h2 className="sidebar__title">Chats</h2>
          <ul className="side-list">
            <SideLink active onClick={() => navigate({ name: "chat" })}>
              {state.settings.agentName}
            </SideLink>
          </ul>
        </>
      );
    case "settings":
      return (
        <>
          <h2 className="sidebar__title">Settings</h2>
          <ul className="side-list">
            {[
              ["send-safety", "Send safety"],
              ["appearance", "Appearance"],
              ["agent", "Your agent"],
              ["developer", "Developer"],
              ["about", "About"],
            ].map(([id, label]) => (
              <SideLink
                key={id}
                active={false}
                onClick={() => document.getElementById(id ?? "")?.scrollIntoView?.({ behavior: "smooth", block: "start" })}
              >
                {label}
              </SideLink>
            ))}
          </ul>
        </>
      );
    case "fleet":
    case "board":
    case "panes":
      return (
        <>
          <h2 className="sidebar__title">Developer</h2>
          <ul className="side-list">
            {DEV_NAV.map((item) => (
              <SideLink key={item.name} active={screen.name === item.name} onClick={() => navigate(item.screen)}>
                {item.label}
              </SideLink>
            ))}
          </ul>
          <p className="sidebar__note muted">From rlx's fleet and boards. Panes are read-only.</p>
        </>
      );
  }
}

function RightPanel() {
  const { state, navigate } = useApp();
  const needs = taskRuns(useRuns()).filter((r) => r.state === "needs-you");
  return (
    <aside className="right-panel" aria-label="Needs you">
      <h2 className="sidebar__title">Needs you</h2>
      {needs.length === 0 && state.drafts.length === 0 ? <p className="muted">Nothing needs you right now.</p> : null}
      <ul className="side-list">
        {needs.map((run) => (
          <SideLink key={run.id} active={false} onClick={() => navigate({ name: "tasks", runId: run.id })}>
            <StateChip state={run.state} /> <span className="side-link__text">{run.title}</span>
          </SideLink>
        ))}
        {state.drafts.map((d) => (
          <SideLink key={d.id} active={false} onClick={() => navigate({ name: "approvals", tab: "drafts" })}>
            <span className="badge">Draft</span> <span className="side-link__text">To {d.destination}</span>
          </SideLink>
        ))}
      </ul>
    </aside>
  );
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
