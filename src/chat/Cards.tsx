import { useId, useState } from "react";
import { SignOff } from "../brand/SignOff.tsx";
import { connectorLabel } from "../core/connectors.ts";
import { sendCheck } from "../core/gate.ts";
import { scheduleLabel } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Card, Message, PriorityItem, SourceLink } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import { MoreMenu } from "../ui/MoreMenu.tsx";
import { AgentEditor } from "./AgentEditor.tsx";

function Sources({ sources }: { sources: SourceLink[] }) {
  return (
    <span className="sources">
      {sources.map((s) => (
        <a key={s.url} className="source" href={s.url} target="_blank" rel="noreferrer" title={s.label} aria-label={`Source: ${s.label} (${connectorLabel(s.connector)})`}>
          {connectorLabel(s.connector).replace(/ \(.*\)$/, "")}
        </a>
      ))}
    </span>
  );
}

function PriorityList({ title, items }: { title: string; items: PriorityItem[] }) {
  return (
    <section className="priority__section" aria-label={title}>
      <h4>{title}</h4>
      <ol className="priority__list">
        {items.map((item) => (
          <PriorityRow key={item.id} item={item} />
        ))}
      </ol>
    </section>
  );
}

/**
 * One priority item. Its reason is a tip: shown on hover and on keyboard focus (of the item or a
 * source link in it), announced through aria-describedby, and dismissed with Escape without
 * moving focus (WCAG 1.4.13).
 */
function PriorityRow({ item }: { item: PriorityItem }) {
  const [dismissed, setDismissed] = useState(false);
  const tipId = useId();
  return (
    <li
      className="reveal-host priority__item"
      tabIndex={0}
      aria-describedby={item.why ? tipId : undefined}
      data-dismissed={dismissed ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !dismissed) {
          e.stopPropagation();
          setDismissed(true);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDismissed(false);
      }}
      onMouseLeave={() => setDismissed(false)}
    >
      <div className="priority__text">{item.text}</div>
      <div className="priority__meta">
        <Sources sources={item.sources} />
        {item.why ? (
          <span className="priority__why tip" role="tooltip" id={tipId} data-testid="why-tip">
            {item.why}
          </span>
        ) : null}
      </div>
    </li>
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
  const { state, core, toast } = useApp();
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

  const { mode, covered, canSend } = sendCheck(draft, state.settings, state.approvals);
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
    // The core's gate decides: sent now, or held for Auto's 10 seconds.
    void core.send(draft.id).then((result) => result === "sent" && toast(`Sent to ${draft.destination}`, "success"));
  };

  return (
    <div className="card-msg email-draft reveal-host" data-testid="email-draft-card">
      <div className="card-msg__head">
        <strong>To {draft.destination}</strong>
        {draft.status === "approved" ? <span className="badge badge--sent">Approved</span> : <span className="badge">Draft</span>}
      </div>
      {draft.subject ? <div className="draft__subject">{draft.subject}</div> : null}
      {editing ? (
        <>
          <label className="field">
            <span>Message</span>
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <SignOff agentName={agentName} ownerName={ownerName} />
        </>
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
                void core.editDraft(draft.id, text);
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
            className="button"
            onClick={() => void core.undoSend(draft.id)}
          >
            Undo
          </button>
        ) : null}
        {draft.status === "held" ? <span className="muted">{hint}</span> : null}
        {editing || draft.status === "held" ? null : (
          <>
            {canSend ? (
              <button type="button" className="button button--primary" onClick={send}>
                <Icon name="send" size={16} /> Send
              </button>
            ) : (
              <button type="button" className="button button--primary" onClick={() => void core.approveDraft(draft.id)}>
                Approve
              </button>
            )}
            <MoreMenu
              label={`More actions for the draft to ${draft.destination}`}
              items={[
                {
                  label: "Edit",
                  onSelect: () => {
                    setText(draft.body);
                    setEditing(true);
                  },
                },
                { label: "Discard", onSelect: () => void core.discardDraft(draft.id) },
              ]}
            />
            <span className="muted card-msg__hint reveal">{hint}</span>
          </>
        )}
      </div>
    </div>
  );
}

function NeedsContextCard({ message, card }: { message: Message; card: Extract<Card, { type: "needs-context" }> }) {
  const { core } = useApp();
  const [answer, setAnswer] = useState("");
  // The core turns the answer into a draft reply, and posts it under the card.
  const reply = (value: string) => core.answerNeedsContext(message.id, value);
  return (
    <div className="card-msg needs-context" data-testid="needs-context-card">
      <div className="card-msg__head">
        <span className="badge badge--warning">Needs your answer</span>
      </div>
      <p>{card.question}</p>
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
          {["I'm free Tuesday at 11:00 or Wednesday at 15:00", "Thursday afternoon works for me"].map((q) => (
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
        <strong>{card.text}</strong>
        <span className="badge">Due {card.due}</span>
      </div>
      <div className="priority__meta reveal-host" tabIndex={0}>
        <Sources sources={card.sources} />
        <span className="muted reveal">From {card.meeting}</span>
      </div>
    </div>
  );
}

function ProposalCard({ message, card }: { message: Message; card: Extract<Card, { type: "proposal" }> }) {
  const { core } = useApp();
  const [value, setValue] = useState(card.proposal);
  if (card.status !== "proposed") {
    return (
      <div className="card-msg proposal is-done" data-testid="proposal-card">
        <div className="card-msg__head">
          <span className="badge">{card.status === "confirmed" ? "Agent created" : "Cancelled"}</span>
          <strong>{card.proposal.name}</strong>
        </div>
        <p className="muted">
          {card.proposal.connectors.map(connectorLabel).join(", ")} · {scheduleLabel(card.proposal.schedule)} · {card.proposal.mode}
        </p>
      </div>
    );
  }
  // The core creates and schedules the agent, and confirms in the channel.
  const confirm = () => void core.confirmProposal(message.id, value);
  return (
    <div className="card-msg proposal" data-testid="proposal-card">
      <div className="card-msg__head">
        <span className="badge">New agent</span>
        <strong>Proposal</strong>
      </div>
      <AgentEditor value={value} onChange={setValue} idPrefix={message.id} fold />
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={!value.name.trim() || value.connectors.length === 0} onClick={confirm}>
          Confirm
        </button>
        <button type="button" className="button" onClick={() => void core.cancelProposal(message.id)}>
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
