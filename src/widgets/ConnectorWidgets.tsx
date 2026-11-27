import { useEffect, useState, type ReactNode } from "react";
import { GMAIL, SLACK } from "../core/connectors.ts";
import type { NewDraft } from "../core/types.ts";
import type { Feed, FeedItem, GmailDashboard } from "../engine/fake/data.ts";
import { useEngineData, useNow } from "../engine/hooks.ts";
import { useApp } from "../state/context.ts";
import { Icon } from "../ui/Icon.tsx";
import { MoreMenu } from "../ui/MoreMenu.tsx";
import type { GenericManifest } from "./manifest.ts";

function ago(now: number, then: number | null): string {
  if (then === null) return "not checked yet";
  const min = Math.floor((now - then) / 60_000);
  return min < 1 ? "checked just now" : `checked ${min} min ago`;
}

/** A Draft for the owner to approve; widget and data-job drafts always need the owner. */
function useCreateDraft() {
  const { core, toast, state } = useApp();
  return (draft: NewDraft) => {
    core.createDraft(draft);
    toast(`Draft saved for your approval. ${state.settings.agentName} won't send it until you approve.`, "success");
  };
}

const SLACK_INTERVALS = [5, 10, 15, 30, 60] as const;

/**
 * One feed item, calm: a single line, its title. The channel, time, the reason it needs you
 * and any action show on hover or keyboard focus, as Gmail's mail does, and the line unwraps
 * then.
 */
function FeedRow({ item, action }: { item: FeedItem; action?: ReactNode }) {
  const meta = [item.subtitle, item.time].filter(Boolean).join(" · ");
  return (
    <li className={`feed__item reveal-host${item.needsYou ? " feed__item--needs-you" : ""}`} tabIndex={0}>
      <div className="feed__title feed__line">{item.title}</div>
      <div className="reveal-block feed__more">
        {meta ? <p className="muted">{meta}</p> : null}
        {item.needsYou && item.why ? (
          <p className="feed__why" data-testid="needs-you-why">
            <strong>Needs you:</strong> {item.why}
          </p>
        ) : null}
        {action}
      </div>
    </li>
  );
}

export function SlackDigestWidget({ settingsOpen }: { settingsOpen: boolean }) {
  const { state, updateSettings, core, demo } = useApp();
  const interval = state.settings.slackIntervalMin;
  const { data, status, fetchedAt, refresh } = useEngineData<Feed>(
    "widget_refresh",
    `Slack: what needs ${state.settings.ownerName}, across DMs, mentions, threads and channels`,
    { kind: "connectors", connectors: [SLACK] },
    interval,
  );
  const now = useNow(30_000);
  const createDraft = useCreateDraft();
  const reviewed = data?.reviewed;
  // This widget is the Slack agent's silent run: each fetch is its latest outcome.
  useEffect(() => {
    if (fetchedAt === null || reviewed === undefined) return;
    const outcome = reviewed > 0 ? `Claude reviewed ${reviewed} new` : "Fetched, nothing new, no Claude usage";
    core.recordAgentRun("slack-agent", { at: fetchedAt, outcome, modelTurn: reviewed > 0 });
  }, [fetchedAt, reviewed, core]);
  return (
    <div className="feed">
      <div className="widget__meta-row">
      <p className="widget__meta reveal-host" data-testid="slack-meta" tabIndex={0}>
        {reviewed === undefined ? (
          <span>{status === "refreshing" ? "Checking…" : ago(now, fetchedAt)}</span>
        ) : reviewed > 0 ? (
          <span className="turn-chip turn-chip--model" data-testid="slack-turn">
            Claude reviewed {reviewed} new
          </span>
        ) : (
          <span className="turn-chip" data-testid="slack-turn">
            Nothing new, no Claude usage
          </span>
        )}
        <span className="reveal widget__meta-more">
          {reviewed === undefined ? "" : `${ago(now, fetchedAt)} · `}every {interval} min
        </span>
      </p>
      <MoreMenu
        label="More actions for Slack digest"
        items={[
          { label: "Refresh now", disabled: status === "refreshing", onSelect: refresh },
          ...(demo
            ? [
                {
                  label: "New messages arrive (demo)",
                  onSelect: () => {
                    demo.simulateNewSlack(3);
                    refresh();
                  },
                },
              ]
            : []),
        ]}
      />
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
              <FeedRow
                key={item.id}
                item={item}
                action={
                  item.needsYou ? (
                    <button
                      type="button"
                      className="button button--sm"
                      onClick={() =>
                        createDraft({
                          origin: "widget",
                          connector: SLACK,
                          destination: item.subtitle ?? "Slack",
                          body: `Thanks, I'm on it. I'll follow up shortly.`,
                          context: `Reply to: ${item.title}`,
                        })
                      }
                    >
                      Draft reply
                    </button>
                  ) : undefined
                }
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * One Gmail section, calm: its header, a count and one line, with the items behind a fold.
 * Inside, each item is one line; its snippet, time and action appear on hover or keyboard focus.
 */
function GmailSection({ title, count, line, open, children }: { title: string; count: number; line: string; open?: boolean; children: ReactNode }) {
  return (
    <section className="gmail__section" aria-label={title}>
      <details className="gmail__fold" open={open ? true : undefined}>
        <summary>
          <h4>{title}</h4>
          <span className="gmail__count" aria-label={`${count} item${count === 1 ? "" : "s"}`}>
            {count}
          </span>
          <span className="gmail__line muted">{line}</span>
        </summary>
        <div className="gmail__items">{children}</div>
      </details>
    </section>
  );
}

export function GmailWidget({ settingsOpen }: { settingsOpen: boolean }) {
  const { state, updateSettings } = useApp();
  const { data } = useEngineData<GmailDashboard>(
    "widget_refresh",
    "Gmail: needs a reply, important unread, key senders, a daily digest and today's meetings",
    { kind: "connectors", connectors: [GMAIL] },
    15,
  );
  const createDraft = useCreateDraft();
  const [newSender, setNewSender] = useState("");
  if (!data) return <p className="muted">Checking Gmail…</p>;
  const keySenders = state.settings.keySenders;
  const names = (list: { from: string }[]) => list.map((m) => m.from).join(", ") || "Nothing waiting";
  const next = data.meetings[0];
  return (
    <div className="gmail">
      <GmailSection title="Needs a reply" count={data.needsReply.length} line={names(data.needsReply)}>
        {data.needsReply.map((m) => (
          <div key={m.id} className="mail reveal-host" tabIndex={0}>
            <div className="mail__line">
              <strong>{m.from}</strong> <span className="muted">{m.subject}</span>
            </div>
            <div className="reveal-block mail__more">
              <p className="muted">
                {m.snippet} <span className="mail__time">· {m.time}</span>
              </p>
              <button
                type="button"
                className="button button--sm"
                onClick={() =>
                  createDraft({
                    origin: "widget",
                    connector: GMAIL,
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
          </div>
        ))}
      </GmailSection>
      <GmailSection title="Important unread" count={data.importantUnread.length} line={names(data.importantUnread)}>
        {data.importantUnread.map((m) => (
          <div key={m.id} className="mail reveal-host" tabIndex={0}>
            <div className="mail__line">
              <strong>{m.from}</strong> <span className="muted">{m.subject}</span>
            </div>
            <div className="reveal-block mail__more">
              <p className="muted mail__time">{m.time}</p>
            </div>
          </div>
        ))}
      </GmailSection>
      <GmailSection title="Key senders" count={keySenders.length} line={keySenders.join(", ") || "None yet"} open={settingsOpen}>
        <ul className="chips">
          {keySenders.map((sender) => {
            const latest = data.keySenders.find((k) => k.sender === sender)?.latest;
            return (
              <li key={sender} className="chip">
                <span>
                  {sender}
                  <span className="muted"> · {latest ? latest.subject : "nothing new"}</span>
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
      </GmailSection>
      <GmailSection title="Daily digest" count={data.digest.drafts.length} line={data.digest.summary}>
        {data.digest.drafts.map((d) => (
          <div key={d.id} className="mail reveal-host" tabIndex={0}>
            <div className="mail__line">
              <strong>To {d.to}</strong> <span className="muted">{d.subject}</span>
            </div>
            <div className="reveal-block mail__more">
              <p className="muted">{d.body}</p>
              <button
                type="button"
                className="button button--sm"
                onClick={() =>
                  createDraft({
                    origin: "dataJob",
                    connector: GMAIL,
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
          </div>
        ))}
      </GmailSection>
      <GmailSection title="Today's meetings" count={data.meetings.length} line={next ? `Next: ${next.time} ${next.title}` : "No meetings"}>
        <ul className="meetings">
          {data.meetings.map((m) => (
            <li key={m.id} className="reveal-host" tabIndex={0}>
              <span className="meetings__time">{m.time}</span> {m.title} <span className="muted reveal">· {m.with}</span>
            </li>
          ))}
        </ul>
      </GmailSection>
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
          <FeedRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
