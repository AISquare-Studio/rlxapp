import { useEffect, useMemo, useRef, useState } from "react";
import { AgentActions, AgentDetails, StatusChip } from "../agents/AgentDetails.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { CardView } from "../chat/Cards.tsx";
import { connectorLabel } from "../core/connectors.ts";
import { useNow } from "../engine/hooks.ts";
import { MANAGER_ID, agentStatus, type Agent } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Card, Message } from "../state/model.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { CenterNav } from "../ui/CenterNav.tsx";
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
  const agent = state.agents.find((a) => a.id === id);
  if (id !== MANAGER_ID && !agent) {
    return (
      <div className="channel">
        <p className="muted">This agent was removed.</p>
      </div>
    );
  }
  return <Conversation id={id} agent={agent} />;
}

/** What a screen reader hears for a card: its gist, never its whole content. */
function spokenCard(card: Card): string {
  switch (card.type) {
    case "email-draft":
      return "A draft for your approval.";
    case "needs-context":
      return `Needs your answer: ${card.question}`;
    case "checklist":
      return card.title;
    case "priority":
      return card.title;
    case "promise":
      return card.text;
    case "proposal":
      return `Proposal: ${card.proposal.name}, ${card.proposal.connectors.map(connectorLabel).join(", ")}`;
  }
}

function spoken(message: Message): string {
  return [message.text, message.card ? spokenCard(message.card) : ""].filter(Boolean).join(" ");
}

/**
 * The channel's announcements (F10): each new message from the agent once it's final, never a
 * reply while it streams, and never what was already there when the channel opened.
 */
export function MessageAnnouncer({ messages }: { messages: Message[] }) {
  const announced = useRef<Set<string> | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const finals = messages.filter((m) => m.from !== "owner" && !m.streaming);
    if (announced.current === null) {
      announced.current = new Set(finals.map((m) => m.id));
      return;
    }
    const seen = announced.current;
    const fresh = finals.filter((m) => !seen.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) seen.add(m.id);
    setText(fresh.map(spoken).filter(Boolean).join(" "));
  }, [messages]);
  return (
    <div className="visually-hidden" aria-live="polite" data-testid="messages-live">
      {text}
    </div>
  );
}

function Conversation({ id, agent }: { id: string; agent?: Agent }) {
  const { state, core, demo } = useApp();
  const { running, simulateNine } = useAgents();
  const nowTick = useNow(30_000);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const messages = useMemo(() => state.messages.filter((m) => m.channel === id), [state.messages, id]);
  const isManager = id === MANAGER_ID;
  const name = isManager ? "Manager" : (agent?.name ?? "");
  const { ownerName } = state.settings;
  const status = agent ? agentStatus(agent, running.has(agent.id), nowTick) : undefined;

  const send = async (value: string) => {
    const body = value.trim();
    if (!body || busy) return;
    setText("");
    setBusy(true);
    // The manager turns it into a proposal card; an agent's channel gets a chat turn whose reply streams in.
    await core.sendMessage(id, body).finally(() => setBusy(false));
  };

  return (
    <div className="channel">
      <div className="channel__top">
        <CenterNav
          lead={<Avatar letter={isManager ? "r" : (agent?.avatar ?? "?")} status={status?.kind} manager={isManager} />}
          title={isManager ? "Manager" : `# ${name.toLowerCase().replace(/\s+/g, "-")}`}
          actions={
            agent && status ? (
              <>
                <StatusChip status={status} />
                <AgentActions agent={agent} compact extra={demo && agent.role === "briefing" ? [{ label: "Simulate 9:00 (demo)", onSelect: simulateNine }] : []} />
              </>
            ) : (
              <span className="muted">Your setup assistant</span>
            )
          }
        />
        {agent ? (
          <details className="fold channel__about">
            <summary>About {agent.name}</summary>
            <AgentDetails agent={agent} />
          </details>
        ) : null}
      </div>
      <ol className="messages" aria-label={`Messages in ${name}`} data-testid="messages">
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
            <li
              key={m.id}
              className={`message reveal-host${grouped ? " message--grouped" : ""}${m.from === "owner" ? " message--owner" : ""}`}
              tabIndex={0}
            >
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
      <MessageAnnouncer messages={messages} />
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
