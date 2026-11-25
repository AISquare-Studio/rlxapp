import { useEffect, useState } from "react";
import { useAgents } from "../agents/useAgents.ts";
import { PriorityCard } from "../chat/Cards.tsx";
import { useNow } from "../engine/hooks.ts";
import { MANAGER_ID, agentStatus, scheduleLabel, wakeLabel } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import { MoreMenu } from "../ui/MoreMenu.tsx";
import { useOverlayCount } from "../ui/overlays.ts";
import type { WidgetInstance, WidgetType } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { AgentWidget, AskAgentFlow } from "../widgets/AgentWidget.tsx";
import { GenericConnectorWidget, GmailWidget, SlackDigestWidget } from "../widgets/ConnectorWidgets.tsx";
import { genericManifest } from "../widgets/manifest.ts";
import { ClockWidget, PomodoroWidget, TimerWidget } from "../widgets/TimeWidgets.tsx";
import { WidgetCard } from "../widgets/WidgetCard.tsx";

const CATALOG: { type: WidgetType; title: string; description: string; connector?: string }[] = [
  { type: "slack", title: "Slack digest", description: "What needs you across DMs, mentions, threads and channels" },
  { type: "gmail", title: "Gmail dashboard", description: "Needs a reply, important unread, key senders, digest, meetings" },
  { type: "clock", title: "Clock", description: "Local time and date" },
  { type: "timer", title: "Timer", description: "A countdown with start, pause and reset" },
  { type: "pomodoro", title: "Pomodoro", description: "25-minute focus sessions with breaks" },
  { type: "generic", title: "Linear", description: "A generic connector widget from a manifest", connector: "claude.ai Linear" },
  { type: "ask", title: "Ask your agent", description: "Ask your agent to make a new widget" },
];

let widgetCounter = 0;

function titleOf(widget: WidgetInstance, agentName: string): string {
  switch (widget.type) {
    case "slack":
      return "Slack digest";
    case "gmail":
      return "Gmail";
    case "clock":
      return "Clock";
    case "timer":
      return "Timer";
    case "pomodoro":
      return "Pomodoro";
    case "generic":
      return genericManifest(widget.connector ?? "claude.ai Linear").title;
    case "agent":
      return widget.title ?? "Agent-made widget";
    case "ask":
      return `Ask ${agentName}`;
  }
}

/** The "Start of day" dashboard section: the briefing agent's latest output, or how to get one. */
function StartOfDay() {
  const { state, navigate, demo } = useApp();
  const { agents, running, wake, simulateNine } = useAgents();
  const now = useNow(30_000);
  const agent = agents.find((a) => a.role === "briefing");
  const briefing = state.briefing;
  if (!agent) {
    return (
      <section className="briefing briefing--empty" aria-label="Start of day">
        <div>
          <h2>Start of day</h2>
          <p className="muted">One calm list each morning.</p>
        </div>
        <button type="button" className="button" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
          <Icon name="sparkle" size={16} /> Set it up
        </button>
      </section>
    );
  }
  const status = agentStatus(agent, running.has(agent.id), now);
  return (
    <section className="briefing" aria-label="Start of day">
      <div className="briefing__head">
        <div>
          <h2>{agent.name}</h2>
          <p className="muted reveal-host" data-testid="briefing-meta" tabIndex={0}>
            {status.kind === "running"
              ? "Running now…"
              : briefing
                ? `Updated ${new Date(briefing.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Hasn't run yet"}
            <span className="reveal">
              {" · "}
              {scheduleLabel(agent.schedule)}
              {status.next !== undefined ? ` · next ${wakeLabel(status.next, now)}` : ""}
            </span>
          </p>
        </div>
        <div className="button-row">
          {demo ? (
            <button type="button" className="button button--sm" onClick={simulateNine} title="Demo control: fire the weekday 09:00 schedule now">
              <Icon name="play" size={14} /> Simulate 9:00 <span className="demo-tag">demo</span>
            </button>
          ) : null}
          <MoreMenu
            label={`More actions for ${agent.name}`}
            items={[
              { label: "Wake now", disabled: status.kind === "running" || status.kind === "paused", onSelect: () => void wake(agent) },
              { label: "Open channel", onSelect: () => navigate({ name: "channel", id: agent.id }) },
            ]}
          />
        </div>
      </div>
      {briefing ? <PriorityCard card={briefing.card} /> : <p className="muted empty-quiet">Nothing yet. It fills in after its next run.</p>}
    </section>
  );
}

export function Home() {
  const { state, dispatch, toast, platform } = useApp();
  const { widgets, agentName } = state.settings;
  // A modal, toast or notification over Home: the widget host's tiles hide (follow-up 7).
  const overlays = useOverlayCount();
  const covered = overlays > 0 || state.toasts.length > 0 || state.notices.length > 0;
  useEffect(() => {
    platform.setWidgetsCovered(covered);
  }, [platform, covered]);
  const [picker, setPicker] = useState(false);
  const [asking, setAsking] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const add = (type: WidgetType, connector?: string) => {
    if (type === "ask") {
      setPicker(false);
      setAsking(true);
      return;
    }
    widgetCounter += 1;
    dispatch({ type: "widget-add", widget: { id: `w-${type}-${Date.now().toString(36)}-${widgetCounter}`, type, connector } });
    setPicker(false);
    toast("Widget added", "success");
  };

  return (
    <div className="home">
      <div className="screen-header">
        <div>
          <h1>Home</h1>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={() => setPicker(true)}>
            <Icon name="plus" size={16} /> Add widget
          </button>
        </div>
      </div>

      <StartOfDay />

      {/*
        Built-ins render as escaped React in main: on Windows and Linux by the widget host's
        policy, and on macOS until the core ships built-in documents for the widgets webview.
        Agent-made tiles go through platform.widgetSource (inline in the preview, the widgets
        webview in the app, or off by policy).
      */}
      <h2 className="section-title">Widgets</h2>
      <div className="widget-grid" data-covered={covered ? "true" : undefined}>
        {widgets.map((widget, index) => {
          const title = titleOf(widget, agentName);
          const settingsOpen = settingsFor === widget.id;
          const hasSettings = widget.type === "slack" || widget.type === "gmail";
          const move = (to: number) => dispatch({ type: "widget-move", id: widget.id, to });
          return (
            <WidgetCard
              key={widget.id}
              id={widget.id}
              title={title}
              index={index}
              count={widgets.length}
              wide={widget.type === "gmail"}
              tall={widget.type === "gmail" || widget.type === "slack"}
              onMove={move}
              onRemove={() => dispatch({ type: "widget-remove", id: widget.id })}
              onDropWidget={(dragged) => dispatch({ type: "widget-move", id: dragged, to: index })}
              actions={
                hasSettings ? (
                  <button
                    type="button"
                    className={`icon-button icon-button--sm${settingsOpen ? " is-active" : ""}`}
                    aria-label={`${title} settings`}
                    aria-pressed={settingsOpen}
                    onClick={() => setSettingsFor(settingsOpen ? null : widget.id)}
                  >
                    <Icon name="gear" size={16} />
                  </button>
                ) : null
              }
            >
              {widget.type === "slack" ? <SlackDigestWidget settingsOpen={settingsOpen} /> : null}
              {widget.type === "gmail" ? <GmailWidget settingsOpen={settingsOpen} /> : null}
              {widget.type === "clock" ? <ClockWidget /> : null}
              {widget.type === "timer" ? <TimerWidget /> : null}
              {widget.type === "pomodoro" ? <PomodoroWidget /> : null}
              {widget.type === "generic" ? <GenericConnectorWidget manifest={genericManifest(widget.connector ?? "claude.ai Linear")} /> : null}
              {widget.type === "agent" ? <AgentWidget id={widget.id} title={title} html={widget.html} /> : null}
              {widget.type === "ask" ? (
                <div className="ask-card">
                  <p>Describe a widget and {agentName} builds it, previews it, and adds it when you say so.</p>
                  <button type="button" className="button button--primary" onClick={() => setAsking(true)}>
                    <Icon name="sparkle" size={16} /> Ask {agentName} to make a widget
                  </button>
                </div>
              ) : null}
            </WidgetCard>
          );
        })}
      </div>

      {picker ? (
        <Modal title="Add a widget" onClose={() => setPicker(false)}>
          <ul className="catalog">
            {CATALOG.map((item) => (
              <li key={item.title}>
                <button type="button" className="catalog__item" onClick={() => add(item.type, item.connector)}>
                  <strong>{item.type === "ask" ? `Ask ${agentName}` : item.title}</strong>
                  <span className="muted">{item.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}

      {asking ? (
        <AskAgentFlow
          onClose={() => setAsking(false)}
          onAdd={(title, html) => {
            widgetCounter += 1;
            dispatch({ type: "widget-add", widget: { id: `w-agent-${Date.now().toString(36)}-${widgetCounter}`, type: "agent", title, html } });
            setAsking(false);
            toast(`${agentName} added “${title}”`, "success");
          }}
        />
      ) : null}
    </div>
  );
}
