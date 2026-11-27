/**
 * Widgets' data jobs (architecture §5.1): what one refresh of a widget runs. Each refresh is one
 * engine run whose finished output is the widget's data. The core runs these; screens only
 * watch a widget and read its data.
 */
import type { Agent } from "../state/agents.ts";
import type { Settings, WidgetInstance } from "../state/model.ts";
import { AUTO_ACCOUNT, type AccountChoice, type Mount, type RunKind } from "../engine/types.ts";
import { genericManifest } from "../widgets/manifest.ts";
import { GMAIL, LINEAR, SLACK, type ConnectorId } from "./connectors.ts";

export interface DataJob {
  kind: RunKind;
  prompt: string;
  mount: Mount;
  /** Minutes between refreshes; none refreshes only on demand. */
  everyMin?: number;
  /** The agent whose silent run this is: its outcome is recorded on that agent. */
  agentId?: string;
  account: AccountChoice;
}

/** The connector a widget reads, if it reads one. */
export function widgetConnector(widget: WidgetInstance): ConnectorId | undefined {
  if (widget.type === "slack") return SLACK;
  if (widget.type === "gmail") return GMAIL;
  if (widget.type === "generic") return widget.connector ?? LINEAR;
  return undefined;
}

/** The agent a widget belongs to: its own link, else the agent that outputs to a widget from the same connector. */
export function linkedAgent(widget: WidgetInstance, agents: Agent[]): string | undefined {
  if (widget.agentId) return widget.agentId;
  const connector = widgetConnector(widget);
  if (!connector) return undefined;
  return agents.find((a) => a.outputs.includes("widget") && a.connectors.includes(connector))?.id;
}

/** A widget's data job, or null for widgets with no data (clock, timer, pomodoro, ask). */
export function dataJob(widget: WidgetInstance, settings: Pick<Settings, "ownerName" | "slackIntervalMin">): DataJob | null {
  const common = { kind: "widget_refresh" as const, agentId: widget.agentId, account: widget.account ?? AUTO_ACCOUNT };
  switch (widget.type) {
    case "slack":
      return {
        ...common,
        prompt: `Slack: what needs ${settings.ownerName}, across DMs, mentions, threads and channels`,
        mount: { kind: "connectors", connectors: [SLACK] },
        everyMin: settings.slackIntervalMin,
      };
    case "gmail":
      return {
        ...common,
        prompt: "Gmail: needs a reply, important unread, key senders, a daily digest and today's meetings",
        mount: { kind: "connectors", connectors: [GMAIL] },
        everyMin: 15,
      };
    case "generic": {
      const manifest = genericManifest(widget.connector ?? LINEAR);
      return { ...common, prompt: manifest.data.prompt, mount: { kind: "connectors", connectors: [manifest.data.connector] }, everyMin: manifest.data.every.minutes };
    }
    case "agent":
      return { ...common, prompt: "Count open pull requests per repository, and how many are in review", mount: { kind: "no_tools" }, everyMin: 15 };
    default:
      return null;
  }
}

/** What a refresh cost, from a Feed's `reviewed` count: the outcome recorded on its agent. */
export function refreshOutcome(output: unknown): { outcome: string; modelTurn: boolean } | null {
  const reviewed = (output as { reviewed?: unknown } | null)?.reviewed;
  if (typeof reviewed !== "number") return null;
  return reviewed > 0 ? { outcome: `Claude reviewed ${reviewed} new`, modelTurn: true } : { outcome: "Fetched, nothing new, no Claude usage", modelTurn: false };
}
