import { useState } from "react";
import { nextId } from "../agents/useAgents.ts";
import { SignOff } from "../brand/SignOff.tsx";
import { START_OF_DAY_ID, avatarFor, nextWake, scheduleLabel, wakeLabel } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Card, Message, PriorityItem, SourceLink } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import { AgentEditor } from "./AgentEditor.tsx";

/** Auto's 10-second holds, by draft id, so Undo can stop one. */
const holds = new Map<string, ReturnType<typeof setTimeout>>();
const HOLD_MS = 10_000;

function Sources({ sources }: { sources: SourceLink[] }) {
  return (
    <span className="sources">
      {sources.map((s) => (
        <a key={s.url} className="source" href={s.url} target="_blank" rel="noreferrer" title={`Open the source in ${s.connector}`}>
          <span className="source__connector">{s.connector.replace(/ \(.*\)$/, "")}</span> {s.label}
        </a>
      ))}
    </span>
  );
}

function PriorityList({ title, items }: { title: string; items: PriorityItem[] }) {
  return (
    <section className="priority__section" aria-label={title}>
      <h4>
        {title} <span className="muted">{items.length}</span>
      </h4>
      <ol className="priority__list">
        {items.map((item) => (
          <li key={item.id}>
            <div className="priority__text">{item.text}</div>
            {item.why ? <div className="muted priority__why">{item.why}</div> : null}
            <Sources sources={item.sources} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PriorityCard({ card }: { card: Extract<Card, { type: "priority" }> }) {
  return (
    <div className="card-msg priority" data-testid="priority-card">
      <PriorityList title="Do now" items={card.doNow} />
      <PriorityList title="Today" items={card.today} />
      <PriorityList title="Waiting on you" items={card.waiting} />
    </div>
  );
}

function EmailDraftCard({ draftId }: { draftId: string }) {
  const { state, dispatch, now, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const draft = state.drafts.find((d) => d.id === draftId);
  const sent = state.activity.find((a) => a.id === `act-${draftId}`);
  const { agentName, ownerName } = state.settings;

  if (!draft) {
    return (
      <div className="card-msg email-draft is-sent" data-testid="email-draft-card">
        <div className="card-msg__head">
          <span className="badge badge--sent">{sent ? "Sent" : "Discarded"}</span>
          {sent ? <strong>To {sent.destination}</strong> : null}
        </div>
        {sent ? (
          <div className="draft__body">
            <p>{sent.body}</p>
            <span className="sign-off">{sent.signOff}</span>
          </div>
        ) : null}
      </div>
    );
  }

  const mode = state.settings.sendModes[draft.connector] ?? "draft";
  const covered = state.approvals.some((a) => a.status === "active" && a.connector === draft.connector && a.destination === draft.destination);
  const canSend = draft.status === "approved" || mode === "auto" || (mode === "preapproved" && covered);
  const hint =
    draft.status === "held"
      ? "Sending in 10 seconds. You can undo."
      : mode === "auto"
        ? "Auto: Send holds it 10 seconds, with Undo."
        : mode === "preapproved" && covered
          ? "A standing approval covers this destination."
          : draft.status === "approved"
            ? "Approved. Send when you're ready."
            : "Draft mode: approve it first.";

  const send = () => {
    if (mode === "auto" && draft.status !== "approved") {
      dispatch({ type: "draft-status", id: draft.id, status: "held" });
      holds.set(
        draft.id,
        setTimeout(() => {
          holds.delete(draft.id);
          dispatch({ type: "draft-send", id: draft.id, at: now(), approvedBy: "auto" });
        }, HOLD_MS),
      );
      return;
    }
    dispatch({ type: "draft-send", id: draft.id, at: now(), approvedBy: draft.status === "approved" ? "owner" : "standing approval" });
    toast(`Sent to ${draft.destination}`, "success");
  };

  return (
    <div className="card-msg email-draft" data-testid="email-draft-card">
      <div className="card-msg__head">
        <span className="badge">Email draft</span>
        <strong>To {draft.destination}</strong>
        {draft.status === "approved" ? <span className="badge badge--sent">Approved</span> : null}
      </div>
      {draft.subject ? <div className="draft__subject">{draft.subject}</div> : null}
      {editing ? (
        <label className="field">
          <span>Message</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      ) : (
        <div className="draft__body">
          <p>{draft.body}</p>
          <SignOff agentName={agentName} ownerName={ownerName} />
        </div>
      )}
      <div className="button-row">
        {editing ? (
          <>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                dispatch({ type: "draft-edit", id: draft.id, body: text });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button type="button" className="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : draft.status === "held" ? (
          <button
            type="button"
            className="button button--warning"
            onClick={() => {
              const timer = holds.get(draft.id);
              if (timer) clearTimeout(timer);
              holds.delete(draft.id);
              dispatch({ type: "draft-status", id: draft.id, status: "pending" });
            }}
          >
            Undo
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button"
              disabled={draft.status === "approved"}
              onClick={() => dispatch({ type: "draft-status", id: draft.id, status: "approved" })}
            >
              Approve
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setText(draft.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" className="button button--primary" disabled={!canSend} onClick={send}>
              <Icon name="send" size={16} /> Send
            </button>
          </>
        )}
      </div>
      <p className="muted card-msg__hint">{hint}</p>
    </div>
  );
}

function NeedsContextCard({ message, card }: { message: Message; card: Extract<Card, { type: "needs-context" }> }) {
  const { dispatch, now } = useApp();
  const [answer, setAnswer] = useState("");
  const reply = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const draftId = nextId("d");
    dispatch({
      type: "draft-create",
      draft: {
        id: draftId,
        status: "pending",
        origin: "task",
        connector: card.connector,
        destination: card.to,
        subject: card.subject,
        body: card.draftTemplate.replace("{answer}", text),
        createdAt: now(),
        context: `Drafted from your answer: “${text}”`,
      },
    });
    dispatch({ type: "message-card", id: message.id, card: { ...card, answered: text } });
    dispatch({ type: "message-add", message: { id: nextId("m"), channel: message.channel, from: "owner", at: now(), text } });
    dispatch({ type: "message-add", message: { id: nextId("m"), channel: message.channel, from: "agent", at: now(), card: { type: "email-draft", draftId } } });
  };
  return (
    <div className="card-msg needs-context" data-testid="needs-context-card">
      <div className="card-msg__head">
        <span className="badge badge--warning">Needs context</span>
        <strong>Before I reply to {card.to}</strong>
      </div>
      <p>{card.question}</p>
      <Sources sources={card.sources} />
      {card.answered ? (
        <p className="muted">You answered “{card.answered}”. The draft is below.</p>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            reply(answer);
          }}
        >
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label={`Answer: ${card.question}`} />
          <button type="submit" className="button button--primary" disabled={!answer.trim()}>
            Reply
          </button>
        </form>
      )}
      {!card.answered ? (
        <div className="quick-replies" aria-label="Quick replies">
          {["Tuesday 11:00 or Wednesday 15:00", "Thursday afternoon"].map((q) => (
            <button key={q} type="button" className="button button--sm" onClick={() => reply(q)}>
              {q}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChecklistCard({ card }: { card: Extract<Card, { type: "checklist" }> }) {
  const [done, setDone] = useState(card.items.map((i) => i.done));
  return (
    <div className="card-msg checklist" data-testid="checklist-card">
      <div className="card-msg__head">
        <span className="badge">Checklist</span>
        <strong>{card.title}</strong>
      </div>
      <ul>
        {card.items.map((item, i) => (
          <li key={item.text}>
            <label className="check">
              <input type="checkbox" checked={done[i] ?? false} onChange={(e) => setDone((prev) => prev.map((d, j) => (j === i ? e.target.checked : d)))} />
              {item.text}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PromiseCard({ card }: { card: Extract<Card, { type: "promise" }> }) {
  return (
    <div className="card-msg promise" data-testid="promise-card">
      <div className="card-msg__head">
        <span className="badge">Meeting promise</span>
        <strong>Due {card.due}</strong>
      </div>
      <p>{card.text}.</p>
      <p className="muted">From {card.meeting}</p>
      <Sources sources={card.sources} />
    </div>
  );
}

function ProposalCard({ message, card }: { message: Message; card: Extract<Card, { type: "proposal" }> }) {
  const { dispatch, now, state } = useApp();
  const [value, setValue] = useState(card.proposal);
  if (card.status !== "proposed") {
    return (
      <div className="card-msg proposal is-done" data-testid="proposal-card">
        <div className="card-msg__head">
          <span className="badge">{card.status === "confirmed" ? "Agent created" : "Cancelled"}</span>
          <strong>{card.proposal.name}</strong>
        </div>
        <p className="muted">
          {card.proposal.connectors.join(", ")} · {scheduleLabel(card.proposal.schedule)} · {card.proposal.mode}
        </p>
      </div>
    );
  }
  const confirm = () => {
    const slug = value.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const taken = new Set(state.settings.agents.map((a) => a.id));
    let id = value.role === "briefing" && !taken.has(START_OF_DAY_ID) ? START_OF_DAY_ID : slug;
    for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
    dispatch({
      type: "agent-add",
      agent: {
        id,
        name: value.name.trim() || "New agent",
        avatar: avatarFor(value.name, state.settings.agents),
        purpose: value.purpose || "Created with the manager.",
        role: value.role,
        connectors: value.connectors,
        schedule: value.schedule,
        mode: value.mode,
        outputs: value.outputs,
        state: "asleep",
      },
    });
    dispatch({ type: "message-card", id: message.id, card: { ...card, proposal: value, status: "confirmed" } });
    dispatch({
      type: "message-add",
      message: {
        id: nextId("m"),
        channel: message.channel,
        from: "agent",
        at: now(),
        text: `Done. ${value.name} is scheduled for ${scheduleLabel(value.schedule).toLowerCase()}. It sleeps until then; next wake ${wakeLabel(nextWake(value.schedule, now()), now())}.`,
      },
    });
  };
  return (
    <div className="card-msg proposal" data-testid="proposal-card">
      <div className="card-msg__head">
        <span className="badge">New agent</span>
        <strong>Proposal</strong>
      </div>
      <AgentEditor value={value} onChange={setValue} idPrefix={message.id} />
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={!value.name.trim() || value.connectors.length === 0} onClick={confirm}>
          Confirm
        </button>
        <button type="button" className="button" onClick={() => dispatch({ type: "message-card", id: message.id, card: { ...card, status: "cancelled" } })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function CardView({ message }: { message: Message }) {
  const card = message.card;
  if (!card) return null;
  switch (card.type) {
    case "email-draft":
      return <EmailDraftCard draftId={card.draftId} />;
    case "needs-context":
      return <NeedsContextCard message={message} card={card} />;
    case "checklist":
      return <ChecklistCard card={card} />;
    case "priority":
      return <PriorityCard card={card} />;
    case "promise":
      return <PromiseCard card={card} />;
    case "proposal":
      return <ProposalCard message={message} card={card} />;
  }
}
