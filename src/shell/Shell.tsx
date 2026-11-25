import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { APP_HOMEPAGE_URL } from "../brand/homepage.ts";
import { RlxMark } from "../brand/RlxMark.tsx";
import { AgentRunner, useRunningAgents } from "../agents/useAgents.ts";
import { AgentDetails } from "../agents/AgentDetails.tsx";
import { useNow, useRunEvents, useRuns } from "../engine/hooks.ts";
import { taskRuns } from "../engine/runs.ts";
import type { EngineStatus } from "../engine/types.ts";
import { MANAGER_ID, agentStatus, wakeLabel, type Agent, type AgentStatus, type AgentStatusKind } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import { screenTitle, type Screen, type ScreenName } from "../state/model.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";

interface NavItem {
  name: ScreenName;
  label: string;
  icon: IconName;
  screen: Screen;
}

const DEV_NAV: NavItem[] = [
  { name: "runs", label: "Runs", icon: "tasks", screen: { name: "runs" } },
  { name: "fleet", label: "Fleet", icon: "fleet", screen: { name: "fleet" } },
  { name: "board", label: "Board", icon: "board", screen: { name: "board" } },
  { name: "panes", label: "Panes", icon: "panes", screen: { name: "panes" } },
];

const DEV_SCREENS = new Set<ScreenName>(DEV_NAV.map((n) => n.name));
/** Screens with the member/detail panel, as in a chat app's channels. */
const PANEL_SCREENS = new Set<ScreenName>(["home", "channel"]);

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 380;

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
      <div className="shell__body">
        <SpaceRail />
        <div className="sidebar-column" style={{ width: sidebar }}>
          <nav className="sidebar" aria-label={`${screenTitle(screen)} navigation`}>
            <Sidebar />
          </nav>
          <AgentPanel />
        </div>
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
        <main className={`main${screen.name === "channel" ? " main--chat" : ""}`} id="main" aria-label={screenTitle(screen)}>
          {children}
        </main>
        {state.rightPanel && PANEL_SCREENS.has(screen.name) ? <DetailPanel /> : null}
      </div>
      <AgentRunner />
      <Notices />
      <Toasts />
      {state.aboutOpen ? <AboutDialog /> : null}
    </div>
  );
}

function channelName(id: string, agents: Agent[]): string {
  if (id === MANAGER_ID) return "Manager";
  return agents.find((a) => a.id === id)?.name ?? "Channel";
}

function TitleBar() {
  const { state, screen, dispatch, navigate } = useApp();
  const runs = useRuns();
  const inbox = state.drafts.length;
  const crumbs: string[] = [screenTitle(screen)];
  if (screen.name === "channel") crumbs.push(channelName(screen.id, state.settings.agents));
  if (screen.name === "runs" && screen.runId) crumbs.push(runs.find((r) => r.id === screen.runId)?.title ?? "Run");
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
          aria-label="Details panel"
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

function RailButton({ label, icon, active, badge, onClick }: { label: string; icon: IconName; active: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rail__button${active ? " is-active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      {badge ? <span className="badge-count badge-count--rail">{badge}</span> : null}
    </button>
  );
}

/** The rail of spaces: your agents, Developer while it's on, and Settings. */
function SpaceRail() {
  const { state, screen, navigate } = useApp();
  const unread = Object.values(state.unread).reduce((a, b) => a + b, 0);
  const inDev = DEV_SCREENS.has(screen.name);
  const homeSpace = !inDev && screen.name !== "settings";
  return (
    <nav className="rail" aria-label="Spaces">
      <RailButton label="Home" icon="home" active={homeSpace} badge={unread + state.drafts.length} onClick={() => navigate({ name: "home" })} />
      <RailButton label="New agent" icon="plus" active={false} onClick={() => navigate({ name: "channel", id: MANAGER_ID })} />
      {state.settings.devMode ? (
        <div className="rail__group" role="group" aria-label="Developer">
          <span className="rail__divider" aria-hidden="true" />
          <RailButton label="Developer" icon="terminal" active={inDev} onClick={() => navigate({ name: "runs" })} />
        </div>
      ) : null}
      <div className="rail__spacer" />
      <RailButton label="Settings" icon="settings" active={screen.name === "settings"} onClick={() => navigate({ name: "settings" })} />
    </nav>
  );
}

function SideLink({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <li>
      <button type="button" className={`side-link reveal-host${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} aria-label={label} onClick={onClick}>
        {children}
      </button>
    </li>
  );
}

function statusLine(status: AgentStatus, now: number): string {
  if (status.next === undefined) return status.label;
  return `${status.label} · wakes ${wakeLabel(status.next, now)}`;
}

/** The channel list: dashboard, agents and approvals, the manager's DM, and one channel per agent. */
function HomeSidebar() {
  const { screen, navigate, state } = useApp();
  const running = useRunningAgents();
  const now = useNow(30_000);
  const { agents } = state.settings;
  const here = (id: string) => screen.name === "channel" && screen.id === id;
  return (
    <>
      <div className="space-header">
        <strong>{state.settings.ownerName.split(" ")[0] ?? ""}'s space</strong>
      </div>
      <ul className="side-list">
        <SideLink active={screen.name === "home"} onClick={() => navigate({ name: "home" })} label="Dashboard">
          <Icon name="home" size={16} /> Dashboard
        </SideLink>
        <SideLink active={screen.name === "agents"} onClick={() => navigate({ name: "agents" })} label="Agents">
          <Icon name="fleet" size={16} /> Agents <span className="muted side-link__end">{agents.length}</span>
        </SideLink>
        <SideLink active={screen.name === "approvals"} onClick={() => navigate({ name: "approvals", tab: "drafts" })} label="Approvals">
          <Icon name="inbox" size={16} /> Approvals
          {state.drafts.length ? <span className="badge-count side-link__end">{state.drafts.length}</span> : null}
        </SideLink>
        {screen.name === "approvals" ? (
          <li>
            <ul className="side-list side-list--nested">
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
          </li>
        ) : null}
      </ul>
      <h2 className="sidebar__title">Direct messages</h2>
      <ul className="side-list" aria-label="Direct messages">
        <SideLink active={here(MANAGER_ID)} onClick={() => navigate({ name: "channel", id: MANAGER_ID })} label="Manager, setup assistant">
          <Avatar letter="r" manager />
          <span className="side-link__stack">
            <span className="side-link__text">Manager</span>
          </span>
          <Unread id={MANAGER_ID} />
        </SideLink>
      </ul>
      <div className="sidebar__heading-row">
        <h2 className="sidebar__title">Agents</h2>
        <button type="button" className="icon-button icon-button--sm" aria-label="Create an agent with the manager" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <ul className="side-list" aria-label="Agent channels">
        {agents.map((agent) => {
          const status = agentStatus(agent, running.has(agent.id), now);
          return (
            <SideLink key={agent.id} active={here(agent.id)} onClick={() => navigate({ name: "channel", id: agent.id })} label={`${agent.name}, ${status.label}`}>
              <Avatar letter={agent.avatar} status={status.kind} />
              <span className="side-link__stack" title={statusLine(status, now)}>
                <span className="side-link__text">{agent.name}</span>
                <span className="muted side-link__sub reveal" data-testid={`status-${agent.id}`}>
                  {statusLine(status, now)}
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
  return count ? (
    <span className="badge-count side-link__end" aria-label={`${count} unread`}>
      {count}
    </span>
  ) : null;
}

function Sidebar() {
  const { screen, navigate } = useApp();
  switch (screen.name) {
    case "home":
    case "agents":
    case "channel":
    case "approvals":
      return <HomeSidebar />;
    case "settings":
      return (
        <>
          <h2 className="sidebar__title">Settings</h2>
          <ul className="side-list">
            {[
              ["send-safety", "Send safety"],
              ["appearance", "Appearance"],
              ["agent", "Your agent"],
              ["service", "rlx service"],
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
    case "runs":
    case "fleet":
    case "board":
    case "panes":
      return (
        <>
          <h2 className="sidebar__title">Developer</h2>
          <ul className="side-list">
            {DEV_NAV.map((item) => (
              <SideLink key={item.name} active={screen.name === item.name} onClick={() => navigate(item.screen)}>
                <Icon name={item.icon} size={16} /> {item.label}
              </SideLink>
            ))}
          </ul>
          <p className="sidebar__note muted">Raw runs and logs, and rlx's fleet and boards. Panes are read-only.</p>
        </>
      );
  }
}

/** The member/detail panel: an agent's details in its channel; otherwise who's awake and what needs you. */
function DetailPanel() {
  const { screen, state } = useApp();
  const agent = screen.name === "channel" ? state.settings.agents.find((a) => a.id === screen.id) : undefined;
  return (
    <aside className="right-panel" aria-label="Details">
      {agent ? <AgentDetails agent={agent} /> : <Members />}
    </aside>
  );
}

function Members() {
  const { state, navigate } = useApp();
  const running = useRunningAgents();
  const now = useNow(30_000);
  const groups: { kind: AgentStatusKind; title: string }[] = [
    { kind: "running", title: "Running" },
    { kind: "scheduled", title: "Scheduled" },
    { kind: "asleep", title: "Asleep" },
    { kind: "paused", title: "Paused" },
  ];
  const withStatus = state.settings.agents.map((agent) => ({ agent, status: agentStatus(agent, running.has(agent.id), now) }));
  return (
    <>
      <NeedsYou />
      {groups.map((group) => {
        const items = withStatus.filter((x) => x.status.kind === group.kind);
        if (!items.length) return null;
        return (
          <section key={group.kind} aria-label={`${group.title} agents`}>
            <h2 className="sidebar__title">
              {group.title} — {items.length}
            </h2>
            <ul className="side-list">
              {items.map(({ agent, status }) => (
                <SideLink key={agent.id} active={false} onClick={() => navigate({ name: "channel", id: agent.id })}>
                  <Avatar letter={agent.avatar} status={status.kind} />
                  <span className="side-link__stack">
                    <span className="side-link__text">{agent.name}</span>
                    <span className="muted side-link__sub reveal">{status.next !== undefined ? `wakes ${wakeLabel(status.next, now)}` : status.label}</span>
                  </span>
                </SideLink>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** Questions and drafts waiting on the owner, answerable in place. */
function NeedsYou() {
  const { state, navigate } = useApp();
  const needs = taskRuns(useRuns()).filter((r) => r.state === "needs-you");
  if (!needs.length && !state.drafts.length) {
    return (
      <section aria-label="Needs you">
        <h2 className="sidebar__title">Needs you</h2>
        <p className="muted">Nothing needs you right now.</p>
      </section>
    );
  }
  return (
    <section aria-label="Needs you">
      <h2 className="sidebar__title">Needs you</h2>
      {needs.map((run) => (
        <RunQuestion key={run.id} runId={run.id} title={run.title} />
      ))}
      {state.drafts.length ? (
        <button type="button" className="side-link" onClick={() => navigate({ name: "approvals", tab: "drafts" })}>
          <span className="badge">Drafts</span>
          <span className="side-link__text">
            {state.drafts.length} waiting for your approval
          </span>
        </button>
      ) : null}
    </section>
  );
}

function RunQuestion({ runId, title }: { runId: string; title: string }) {
  const { engine, toast } = useApp();
  const events = useRunEvents(runId);
  const [answer, setAnswer] = useState("");
  const question = [...events].reverse().find((e) => e.event.type === "question")?.event;
  if (!question || question.type !== "question") return null;
  return (
    <div className="card-msg needs-context needs-context--compact" data-testid="run-question">
      <div className="card-msg__head">
        <span className="badge badge--warning">Needs context</span>
        <strong className="side-link__text">{title}</strong>
      </div>
      <p>{question.text}</p>
      <form
        className="composer composer--compact"
        onSubmit={(e) => {
          e.preventDefault();
          const text = answer.trim();
          if (!text) return;
          void engine.resume(runId, text).then(() => toast("Thanks. Picking it up again.", "success"));
          setAnswer("");
        }}
      >
        <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label={`Answer: ${question.text}`} />
        <button type="submit" className="button button--sm button--primary" disabled={!answer.trim()}>
          Reply
        </button>
      </form>
    </div>
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

/** Mock system notifications, as a loud run fires them. */
function Notices() {
  const { state, dispatch, navigate } = useApp();
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
                dispatch({ type: "notice-dismiss", id: n.id });
                navigate({ name: "channel", id: n.channel });
              }}
            >
              Open
            </button>
            <button type="button" className="button button--sm" onClick={() => dispatch({ type: "notice-dismiss", id: n.id })}>
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
