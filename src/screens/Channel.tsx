import { useState } from "react";
import { AgentActions, StatusChip } from "../agents/AgentDetails.tsx";
import { nextId, useAgents } from "../agents/useAgents.ts";
import { CardView } from "../chat/Cards.tsx";
import { newRunId, useNow } from "../engine/hooks.ts";
import { CHAT_PREFIX } from "../engine/runs.ts";
import { MANAGER_ID, agentStatus, type Agent } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Message, Proposal } from "../state/model.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Icon } from "../ui/Icon.tsx";

const MANAGER_SUGGESTIONS = [
  "Every weekday at 9, give me a start of day briefing",
  "Watch Linear for bugs assigned to me, every hour",
];

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A conversation: the manager's DM (the setup assistant) or an agent's channel. */
export function Channel({ id }: { id: string }) {
  const { state } = useApp();
  const agent = state.settings.agents.find((a) => a.id === id);
  if (id !== MANAGER_ID && !agent) {
    return (
      <div className="channel">
        <p className="muted">This agent was removed.</p>
      </div>
    );
  }
  return <Conversation id={id} agent={agent} />;
}

function Conversation({ id, agent }: { id: string; agent?: Agent }) {
  const { state, engine, dispatch, now, demo } = useApp();
  const { running, simulateNine } = useAgents();
  const nowTick = useNow(30_000);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const messages = state.messages.filter((m) => m.channel === id);
  const isManager = id === MANAGER_ID;
  const name = isManager ? "Manager" : (agent?.name ?? "");
  const { ownerName } = state.settings;
  const status = agent ? agentStatus(agent, running.has(agent.id), nowTick) : undefined;

  const post = (message: Omit<Message, "id" | "channel" | "at">) => {
    const full: Message = { id: nextId("m"), channel: id, at: now(), ...message };
    dispatch({ type: "message-add", message: full });
    return full.id;
  };

  const send = async (value: string) => {
    const body = value.trim();
    if (!body || busy) return;
    setText("");
    setBusy(true);
    post({ from: "owner", text: body });
    if (isManager) {
      // The manager turns what the owner said into a proposal card (a parse_instruction run).
      const run = await engine.run({ id: newRunId(), kind: "parse_instruction", prompt: body, mount: { kind: "no_tools" }, needsConnectors: [], persist: false });
      const off = engine.attach(run, 1, ({ event }) => {
        if (event.type !== "finished") return;
        off();
        setBusy(false);
        const output = event.output as (Proposal & { reply?: string }) | undefined;
        if (event.status !== "done" || !output) {
          post({ from: "agent", text: "Sorry, I couldn't work that out. Try saying what you want and when." });
          return;
        }
        const { reply, ...proposal } = output;
        post({ from: "agent", text: reply ?? "Here's what I'd set up." });
        post({ from: "agent", card: { type: "proposal", id: nextId("p"), proposal, status: "proposed" } });
      });
      return;
    }
    // An agent's channel: a chat turn with that agent; its reply streams in.
    const replyId = post({ from: "agent", text: "" });
    const run = await engine.run({ id: newRunId(), kind: "task", prompt: `${CHAT_PREFIX}${body}`, mount: { kind: "no_tools" }, needsConnectors: [], persist: true });
    const off = engine.attach(run, 1, ({ event }) => {
      if (event.type === "text") dispatch({ type: "message-append", id: replyId, text: event.delta });
      if (event.type === "finished") {
        off();
        setBusy(false);
      }
    });
  };

  return (
    <div className="channel">
      <header className="channel__header">
        <Avatar letter={isManager ? "r" : (agent?.avatar ?? "?")} status={status?.kind} manager={isManager} />
        <div className="channel__title">
          <h1>{isManager ? "Manager" : `# ${name.toLowerCase().replace(/\s+/g, "-")}`}</h1>
          {agent && status ? null : <span className="muted">Your setup assistant</span>}
        </div>
        {agent && status ? (
          <div className="button-row">
            <StatusChip status={status} />
            <AgentActions agent={agent} compact extra={demo && agent.role === "briefing" ? [{ label: "Simulate 9:00 (demo)", onSelect: simulateNine }] : []} />
          </div>
        ) : null}
      </header>
      <ol className="messages" aria-label={`Messages in ${name}`} aria-live="polite" data-testid="messages">
        {messages.length === 0 ? (
          <li className="messages__empty muted">
            {agent?.mode === "silent"
              ? `${name} is silent: it updates widgets and the dashboard and posts nothing here unless you ask it something.`
              : `Nothing yet. ${name} posts here when it runs.`}
          </li>
        ) : null}
        {messages.map((m, i) => {
          if (m.from === "system") {
            return (
              <li key={m.id} className="message message--system reveal-host" tabIndex={0}>
                <span>{m.text}</span> <time className="muted reveal">{time(m.at)}</time>
              </li>
            );
          }
          const prev = messages[i - 1];
          const grouped = prev !== undefined && prev.from === m.from && m.at - prev.at < 5 * 60_000;
          const who = m.from === "owner" ? ownerName : name;
          return (
            <li key={m.id} className={`message reveal-host${grouped ? " message--grouped" : ""}${m.from === "owner" ? " message--owner" : ""}`}>
              {grouped ? (
                <span className="message__gutter" aria-hidden="true" />
              ) : m.from === "owner" ? (
                <Avatar letter={(ownerName[0] ?? "Y").toUpperCase()} />
              ) : (
                <Avatar letter={isManager ? "r" : (agent?.avatar ?? "?")} manager={isManager} />
              )}
              <div className="message__body">
                {grouped ? null : (
                  <div className="message__meta">
                    <strong>{who}</strong>
                    {m.from === "agent" ? <span className="bot-tag">AI agent</span> : null}
                    <time className="muted reveal">{time(m.at)}</time>
                  </div>
                )}
                {m.text !== undefined ? <p className="message__text">{m.text || "…"}</p> : null}
                <CardView message={m} />
              </div>
            </li>
          );
        })}
        <li key={`end-${messages.length}`} className="messages__end" ref={(el) => el?.scrollIntoView?.({ block: "nearest" })} />
      </ol>
      {isManager && !busy && !messages.some((m) => m.from === "owner") ? (
        <div className="quick-replies" aria-label="Suggestions">
          {MANAGER_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="button button--sm" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="composer channel__composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isManager ? "Tell the manager what you want, e.g. every weekday at 9…" : `Message #${name.toLowerCase().replace(/\s+/g, "-")}`}
          aria-label={`Message ${name}`}
        />
        <button type="submit" className="button button--primary" disabled={!text.trim() || busy}>
          <Icon name="send" size={16} /> Send
        </button>
      </form>
    </div>
  );
}
