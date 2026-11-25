import { useEffect, useState } from "react";
import type { Feed, GmailDashboard } from "../engine/fake/data.ts";
import { useEngineData, useNow } from "../engine/hooks.ts";
import { useApp } from "../state/context.ts";
import type { Draft } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import type { GenericManifest } from "./manifest.ts";

function ago(now: number, then: number | null): string {
  if (then === null) return "not checked yet";
  const min = Math.floor((now - then) / 60_000);
  return min < 1 ? "checked just now" : `checked ${min} min ago`;
}

let draftCounter = 0;
function draftId(): string {
  draftCounter += 1;
  return `d-${Date.now().toString(36)}-${draftCounter}`;
}

/** A Draft for the owner to approve; widget and data-job drafts always need the owner. */
function useCreateDraft() {
  const { dispatch, toast, now, state } = useApp();
  return (draft: Omit<Draft, "id" | "createdAt" | "status">) => {
    dispatch({ type: "draft-create", draft: { ...draft, status: "pending", id: draftId(), createdAt: now() } });
    toast(`Draft saved for your approval. ${state.settings.agentName} won't send it until you approve.`, "success");
  };
}

const SLACK_INTERVALS = [5, 10, 15, 30, 60] as const;

export function SlackDigestWidget({ settingsOpen }: { settingsOpen: boolean }) {
  const { state, updateSettings, dispatch, demo } = useApp();
  const interval = state.settings.slackIntervalMin;
  const { data, status, fetchedAt, refresh } = useEngineData<Feed>(
    "widget_refresh",
    `Slack: what needs ${state.settings.ownerName}, across DMs, mentions, threads and channels`,
    { kind: "connectors", connectors: ["claude.ai Slack"] },
    interval,
  );
  const now = useNow(30_000);
  const createDraft = useCreateDraft();
  const reviewed = data?.reviewed;
  // This widget is the Slack agent's silent run: each fetch is its latest outcome.
  useEffect(() => {
    if (fetchedAt === null || reviewed === undefined) return;
    const outcome = reviewed > 0 ? `Claude reviewed ${reviewed} new` : "Fetched, nothing new, no Claude usage";
    dispatch({ type: "agent-update", id: "slack-agent", patch: { lastRun: { at: fetchedAt, outcome, modelTurn: reviewed > 0 } } });
  }, [fetchedAt, reviewed, dispatch]);
  return (
    <div className="feed">
      <p className="widget__meta" data-testid="slack-meta">
        {status === "refreshing" && !data ? "Checking…" : ago(now, fetchedAt)}
        {reviewed !== undefined ? " · " : null}
        {reviewed !== undefined ? (
          reviewed > 0 ? (
            <span className="turn-chip turn-chip--model" data-testid="slack-turn">
              model turn: Claude reviewed {reviewed} new
            </span>
          ) : (
            <span className="turn-chip" data-testid="slack-turn">
              nothing new, no Claude usage
            </span>
          )
        ) : null}
        {` · every ${interval} min`}
      </p>
      <div className="button-row">
        <button type="button" className="button button--sm" onClick={refresh} disabled={status === "refreshing"}>
          <Icon name="reset" size={14} /> Refresh now
        </button>
        {demo ? (
          <button
            type="button"
            className="button button--sm"
            title="Demo control: the next fetch finds 3 new messages"
            onClick={() => {
              demo.simulateNewSlack(3);
              refresh();
            }}
          >
            New messages arrive <span className="demo-tag">demo</span>
          </button>
        ) : null}
      </div>
      {settingsOpen ? (
        <label className="field field--inline">
          <span>Check every</span>
          <select
            value={interval}
            aria-label="Slack digest interval"
            onChange={(e) => updateSettings({ slackIntervalMin: Number(e.target.value) })}
          >
            {SLACK_INTERVALS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {data ? (
        <>
          <p className="feed__summary">{data.summary}</p>
          <ul className="feed__list">
            {data.items.map((item) => (
              <li key={item.id} className={`feed__item${item.needsYou ? " feed__item--needs-you" : ""}`}>
                <div className="feed__title">{item.title}</div>
                <div className="feed__sub">
                  {item.subtitle} · {item.time}
                </div>
                {item.needsYou ? (
                  <>
                    <div className="feed__why" data-testid="needs-you-why">
                      <strong>Needs you:</strong> {item.why}
                    </div>
                    <button
                      type="button"
                      className="button button--sm"
                      onClick={() =>
                        createDraft({
                          origin: "widget",
                          connector: "claude.ai Slack",
                          destination: item.subtitle ?? "Slack",
                          body: `Thanks, I'm on it. I'll follow up shortly.`,
                          context: `Reply to: ${item.title}`,
                        })
                      }
                    >
                      Draft reply
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function GmailWidget({ settingsOpen }: { settingsOpen: boolean }) {
  const { state, updateSettings } = useApp();
  const { data } = useEngineData<GmailDashboard>(
    "widget_refresh",
    "Gmail: needs a reply, important unread, key senders, a daily digest and today's meetings",
    { kind: "connectors", connectors: ["claude.ai Gmail"] },
    15,
  );
  const createDraft = useCreateDraft();
  const [newSender, setNewSender] = useState("");
  if (!data) return <p className="muted">Checking Gmail…</p>;
  const keySenders = state.settings.keySenders;
  return (
    <div className="gmail">
      <section className="gmail__section" aria-label="Needs a reply">
        <h4>Needs a reply</h4>
        {data.needsReply.map((m) => (
          <div key={m.id} className="mail">
            <div className="mail__head">
              <strong>{m.from}</strong> <span className="muted">{m.time}</span>
            </div>
            <div className="mail__subject">{m.subject}</div>
            <div className="mail__snippet muted">{m.snippet}</div>
            <button
              type="button"
              className="button button--sm"
              onClick={() =>
                createDraft({
                  origin: "widget",
                  connector: "claude.ai Gmail",
                  destination: m.from,
                  subject: `Re: ${m.subject}`,
                  body: `Hi ${m.from.split(" ")[0]}, thanks for this. I'll review it today and come back to you.`,
                  context: `Reply to “${m.subject}”`,
                })
              }
            >
              Draft reply
            </button>
          </div>
        ))}
      </section>
      <section className="gmail__section" aria-label="Important unread">
        <h4>Important unread</h4>
        {data.importantUnread.map((m) => (
          <div key={m.id} className="mail">
            <div className="mail__head">
              <strong>{m.from}</strong> <span className="muted">{m.time}</span>
            </div>
            <div className="mail__subject">{m.subject}</div>
          </div>
        ))}
      </section>
      <section className="gmail__section" aria-label="Key senders">
        <h4>Key senders</h4>
        <ul className="chips">
          {keySenders.map((sender) => {
            const latest = data.keySenders.find((k) => k.sender === sender)?.latest;
            return (
              <li key={sender} className="chip">
                <span>
                  {sender}
                  {latest ? <span className="muted"> · {latest.subject}</span> : <span className="muted"> · nothing new</span>}
                </span>
                {settingsOpen ? (
                  <button
                    type="button"
                    className="chip__remove"
                    aria-label={`Remove ${sender} from key senders`}
                    onClick={() => updateSettings({ keySenders: keySenders.filter((s) => s !== sender) })}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {settingsOpen ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newSender.trim();
              if (name && !keySenders.includes(name)) updateSettings({ keySenders: [...keySenders, name] });
              setNewSender("");
            }}
          >
            <input value={newSender} onChange={(e) => setNewSender(e.target.value)} placeholder="Add a key sender" aria-label="Add a key sender" />
            <button type="submit" className="button button--sm">
              Add
            </button>
          </form>
        ) : null}
      </section>
      <section className="gmail__section" aria-label="Daily digest">
        <h4>Daily digest</h4>
        <p className="muted">{data.digest.summary}</p>
        {data.digest.drafts.map((d) => (
          <div key={d.id} className="mail mail--draft">
            <div className="mail__head">
              <strong>To {d.to}</strong> <span className="badge">Drafted reply</span>
            </div>
            <div className="mail__snippet">{d.body}</div>
            <button
              type="button"
              className="button button--sm"
              onClick={() =>
                createDraft({
                  origin: "dataJob",
                  connector: "claude.ai Gmail",
                  destination: d.to,
                  subject: d.subject,
                  body: d.body,
                  context: "From your daily digest",
                })
              }
            >
              Review draft
            </button>
          </div>
        ))}
      </section>
      <section className="gmail__section" aria-label="Today's meetings">
        <h4>Today's meetings</h4>
        <ul className="meetings">
          {data.meetings.map((m) => (
            <li key={m.id}>
              <span className="meetings__time">{m.time}</span> {m.title} <span className="muted">· {m.with}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function GenericConnectorWidget({ manifest }: { manifest: GenericManifest }) {
  const { data } = useEngineData<Feed>(
    "widget_refresh",
    manifest.data.prompt,
    { kind: "connectors", connectors: [manifest.data.connector] },
    manifest.data.every.minutes,
  );
  if (!data) return <p className="muted">Checking {manifest.title}…</p>;
  return (
    <div className="feed" data-testid="generic-widget">
      <p className="feed__summary">{data.summary}</p>
      <ul className="feed__list">
        {data.items.map((item) => (
          <li key={item.id} className={`feed__item${item.needsYou ? " feed__item--needs-you" : ""}`}>
            <div className="feed__title">{item.title}</div>
            <div className="feed__sub">
              {item.subtitle} · {item.time}
            </div>
            {item.needsYou && item.why ? (
              <div className="feed__why">
                <strong>Needs you:</strong> {item.why}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
