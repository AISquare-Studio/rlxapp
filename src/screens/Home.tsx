import { useState } from "react";
import { useApp } from "../state/context.ts";
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

export function Home() {
  const { state, dispatch, toast } = useApp();
  const { widgets, agentName } = state.settings;
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
          <p className="muted">Your widgets. {agentName} keeps them up to date in the background.</p>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={() => setAsking(true)}>
            <Icon name="sparkle" size={16} /> Ask {agentName} to make a widget
          </button>
          <button type="button" className="button button--primary" onClick={() => setPicker(true)}>
            <Icon name="plus" size={16} /> Add widget
          </button>
        </div>
      </div>

      <div className="widget-grid">
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
