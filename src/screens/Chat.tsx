import { useState } from "react";
import { newRunId } from "../engine/hooks.ts";
import { CHAT_PREFIX } from "../engine/runs.ts";
import { useApp } from "../state/context.ts";
import { Icon } from "../ui/Icon.tsx";

interface Message {
  id: string;
  from: "owner" | "agent";
  text: string;
}

let messageCounter = 0;
function messageId(): string {
  messageCounter += 1;
  return `m-${messageCounter}`;
}

/** Chat with the agent. Each message is an engine run whose text streams in as the reply. */
export function Chat() {
  const { engine, state } = useApp();
  const { agentName } = state.settings;
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: messageId(), from: "agent", text: `Hi ${state.settings.ownerName.split(" ")[0] ?? ""}, I'm ${agentName}. What can I help with?` },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    const replyId = messageId();
    setMessages((prev) => [...prev, { id: messageId(), from: "owner", text }, { id: replyId, from: "agent", text: "" }]);
    const run = await engine.run({ id: newRunId(), kind: "task", prompt: `${CHAT_PREFIX}${text}`, mount: { kind: "no_tools" }, needsConnectors: [], persist: true });
    const off = engine.attach(run, 1, ({ event }) => {
      if (event.type === "text") {
        setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, text: m.text + event.delta } : m)));
      }
      if (event.type === "finished") {
        const reply = (event.output as { reply?: string } | undefined)?.reply;
        if (reply) setMessages((prev) => prev.map((m) => (m.id === replyId && !m.text ? { ...m, text: reply } : m)));
        setBusy(false);
        off();
      }
    });
  };

  return (
    <div className="chat">
      <div className="screen-header">
        <div>
          <h1>Chat with {agentName}</h1>
          <p className="muted">Ask anything. Sends always become drafts for your approval.</p>
        </div>
      </div>
      <div className="chat__messages" aria-live="polite" data-testid="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.from}`}>
            <span className="bubble__who">{m.from === "agent" ? agentName : "You"}</span>
            <p>{m.text || "…"}</p>
          </div>
        ))}
        <div key={`end-${messages.length}`} ref={(el) => el?.scrollIntoView?.({ block: "nearest" })} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} />
        <button type="submit" className="button button--primary" disabled={!draft.trim() || busy}>
          <Icon name="send" size={16} /> Send
        </button>
      </form>
    </div>
  );
}
