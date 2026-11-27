/**
 * One spelling for connectors everywhere: the claude.ai MCP server name Claude Code reports in
 * `system/init` (architecture §4), e.g. "claude.ai Slack". Agents, widgets, mounts, drafts,
 * approvals, send modes and sources all store this id; people see `connectorLabel(id)`.
 */

export type ConnectorId = string;

export const CLAUDE_AI_PREFIX = "claude.ai ";

export const SLACK: ConnectorId = "claude.ai Slack";
export const GMAIL: ConnectorId = "claude.ai Gmail";
export const LINEAR: ConnectorId = "claude.ai Linear";
export const GOOGLE_CALENDAR: ConnectorId = "claude.ai Google Calendar";
export const GOOGLE_DRIVE: ConnectorId = "claude.ai Google Drive";

/** Labels that aren't just the name: Google Drive is offered for its meeting transcripts. */
const LABELS: Record<ConnectorId, string> = {
  [GOOGLE_DRIVE]: "Meet transcripts (Google Drive)",
};

/** The connectors rlx knows by name. */
export const KNOWN_CONNECTORS: readonly ConnectorId[] = [SLACK, GMAIL, LINEAR, GOOGLE_CALENDAR, GOOGLE_DRIVE];

export function isConnectorId(value: string): boolean {
  return value.startsWith(CLAUDE_AI_PREFIX) && value.length > CLAUDE_AI_PREFIX.length;
}

/** What people see: "Slack" for "claude.ai Slack". */
export function connectorLabel(id: ConnectorId): string {
  return LABELS[id] ?? (isConnectorId(id) ? id.slice(CLAUDE_AI_PREFIX.length) : id);
}

/**
 * The id for a connector however it's written: its id, its name ("Slack") or its label ("Meet
 * transcripts (Google Drive)"), in any case, with stray spaces. A connector rlx doesn't know
 * keeps its name, under the claude.ai prefix.
 */
export function connectorId(name: string): ConnectorId {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const lower = trimmed.toLowerCase();
  const bare = lower.startsWith(CLAUDE_AI_PREFIX.toLowerCase()) ? trimmed.slice(CLAUDE_AI_PREFIX.length) : trimmed;
  const known = KNOWN_CONNECTORS.find((id) =>
    [id, id.slice(CLAUDE_AI_PREFIX.length), connectorLabel(id)].some((spelling) => spelling.toLowerCase() === lower || spelling.toLowerCase() === bare.toLowerCase()),
  );
  return known ?? `${CLAUDE_AI_PREFIX}${bare}`;
}
