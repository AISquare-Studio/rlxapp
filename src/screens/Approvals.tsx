import { useState } from "react";
import { SignOff } from "../brand/SignOff.tsx";
import { connectorLabel } from "../core/connectors.ts";
import { useApp } from "../state/context.ts";
import type { Draft, StandingApproval } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import { CenterNav } from "../ui/CenterNav.tsx";
import { Modal } from "../ui/Modal.tsx";
import { MoreMenu } from "../ui/MoreMenu.tsx";

const TABS = [
  { id: "drafts", label: "Drafts" },
  { id: "standing", label: "Standing approvals" },
  { id: "activity", label: "Activity" },
] as const;

const ORIGIN: Record<Draft["origin"], string> = {
  task: "From a task",
  approval: "From a standing approval",
  widget: "From a widget",
  dataJob: "From a digest",
};

function time(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function Approvals() {
  const { screen, navigate } = useApp();
  const tab = screen.name === "approvals" ? screen.tab : "drafts";
  return (
    <div>
      <CenterNav
        title="Approvals"
        tabsLabel="Approvals"
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, active: tab === t.id, onSelect: () => navigate({ name: "approvals", tab: t.id }) }))}
      />
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === "drafts" ? <Drafts /> : null}
        {tab === "standing" ? <Standing /> : null}
        {tab === "activity" ? <Activity /> : null}
      </div>
    </div>
  );
}

function Drafts() {
  const { state, core, toast } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const { agentName, ownerName } = state.settings;
  if (state.drafts.length === 0) return <p className="empty">No drafts waiting. Drafted replies from widgets and tasks land here.</p>;
  return (
    <ul className="card-list" data-testid="drafts">
      {state.drafts.map((draft) => (
        <li key={draft.id} className="card draft reveal-host">
          <div className="card__head">
            <span className="badge">{connectorLabel(draft.connector)}</span>
            <strong>To {draft.destination}</strong>
            <span className="muted reveal">
              {ORIGIN[draft.origin]} · {time(draft.createdAt)}
            </span>
          </div>
          {draft.subject ? <div className="draft__subject">{draft.subject}</div> : null}
          {draft.context ? (
            <details className="fold">
              <summary>Why this draft</summary>
              <p className="muted draft__context">{draft.context}</p>
            </details>
          ) : null}
          {editing === draft.id ? (
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
            {editing === draft.id ? (
              <>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => {
                    core.editDraft(draft.id, text);
                    setEditing(null);
                  }}
                >
                  Save
                </button>
                <button type="button" className="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => {
                    core.approveAndSend(draft.id);
                    toast(`Sent to ${draft.destination}`, "success");
                  }}
                >
                  <Icon name="send" size={16} /> Approve and send
                </button>
                <MoreMenu
                  label={`More actions for the draft to ${draft.destination}`}
                  items={[
                    {
                      label: "Edit",
                      onSelect: () => {
                        setEditing(draft.id);
                        setText(draft.body);
                      },
                    },
                    {
                      label: "Discard",
                      onSelect: () => {
                        core.discardDraft(draft.id);
                        toast("Draft discarded", "info");
                      },
                    },
                  ]}
                />
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Standing() {
  const { state, core, toast } = useApp();
  const [revoking, setRevoking] = useState<StandingApproval | null>(null);
  return (
    <>
      <ul className="card-list">
        {state.approvals.map((a) => (
          <li key={a.id} className={`card${a.status !== "active" ? " card--inactive" : ""}`}>
            <div className="card__head">
              <span className="badge">{connectorLabel(a.connector)}</span>
              <strong>{a.instruction}</strong>
            </div>
            <dl className="facts">
              <div>
                <dt>Scope</dt>
                <dd>
                  Posts only to {a.destination}, at most {a.maxChars} characters, no broadcast mentions
                </dd>
              </div>
              <div>
                <dt>Trigger</dt>
                <dd>{a.trigger}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{a.expiry === "once" ? "After one send" : "When you revoke it"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{a.status === "active" ? `Active since ${time(a.confirmedAt)}` : a.status === "revoked" ? "Revoked" : "Used"}</dd>
              </div>
            </dl>
            {a.status === "active" ? (
              <div className="button-row">
                <button type="button" className="button" onClick={() => setRevoking(a)}>
                  Revoke
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {revoking ? (
        <Modal
          title="Revoke this approval?"
          tone="danger"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setRevoking(null)}>
                Keep it
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  core.revokeApproval(revoking.id);
                  setRevoking(null);
                  toast("Approval revoked", "info");
                }}
              >
                Revoke
              </button>
            </>
          }
        >
          <p>{revoking.instruction}</p>
          <p className="muted">Future sends like this become drafts for you to approve.</p>
        </Modal>
      ) : null}
    </>
  );
}

function Activity() {
  const { state } = useApp();
  if (state.activity.length === 0) return <p className="empty">Nothing sent yet.</p>;
  return (
    <ul className="card-list" data-testid="activity">
      {state.activity.map((item) => (
        <li key={item.id} className="card">
          <div className="card__head">
            <span className="badge badge--sent">Sent</span>
            <strong>To {item.destination}</strong>
            <span className="muted">
              · {connectorLabel(item.connector)} · approved by {item.approvedBy} · {time(item.at)}
            </span>
          </div>
          {item.subject ? <div className="draft__subject">{item.subject}</div> : null}
          <div className="draft__body">
            <p>{item.body}</p>
            <span className="sign-off" data-testid="activity-sign-off">
              {item.signOff}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
