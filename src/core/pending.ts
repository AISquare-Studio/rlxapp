/**
 * "Pending on you" (owner brief, pending-on-you.md; task #30): one durable list of what waits on
 * the owner, wherever it came from. The core keeps it; the real core mirrors rlxd's `pending.*`.
 * Today's sources are run questions and drafts awaiting approval; #30 adds the rest and the UI.
 */

export type PendingKind =
  /** A run, or a board, asked the owner something. */
  | "question"
  /** A task is blocked on the owner. */
  | "blocked"
  /** A limited agent's handover failed. */
  | "handover"
  /** A dialog left open in an agent's pane (a permission prompt, AskUserQuestion). */
  | "dialog"
  /** The send gate holds a draft for approval. */
  | "approval";

export type PendingStatus = "open" | "answered" | "assumed" | "dismissed";

export interface SuggestedAnswer {
  label: string;
  description?: string;
}

export interface PendingItem {
  id: string;
  /** Increases with every new item on the host; the unread marker compares against it. */
  seq: number;
  project?: string;
  /** Who asked: an agent, a run, the gate. */
  asker: string;
  kind: PendingKind;
  /** A short title for the thing it's about (the run's or draft's). */
  title: string;
  text: string;
  suggested: SuggestedAnswer[];
  /** Only the owner can decide: never assumed (merges to main, releases, spending, deleting, sending for them). */
  ownerOnly: boolean;
  createdAt: number;
  /** After this, the manager may assume the first suggested answer (never for owner-only items). */
  assumeAfter?: number;
  status: PendingStatus;
  answer?: string;
  answeredBy?: "person" | "manager-assumed";
  answeredAt?: number;
  /** Where an answer goes: the run that asked. */
  runId?: string;
  /** The draft an approval item is about. */
  draftId?: string;
}

/**
 * The unread dot's state. `seen` is one per-user marker (the newest item seq seen anywhere),
 * shared across devices; `muted` and `enabled` (the off switch) are host settings.
 */
export interface PendingMarker {
  seen: number;
  muted: boolean;
  enabled: boolean;
}

export const DEFAULT_PENDING_MARKER: PendingMarker = { seen: 0, muted: false, enabled: true };

/** The dot: something open arrived since the section was last seen, unless muted or off. */
export function pendingUnread(items: PendingItem[], marker: PendingMarker): boolean {
  if (!marker.enabled || marker.muted) return false;
  return items.some((item) => item.status === "open" && item.seq > marker.seen);
}

/** The newest seq among `items`, for advancing the marker when the section is seen. */
export function newestSeq(items: PendingItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.seq), 0);
}

/** The manager may assume an answer: open, past its time, has an answer to assume, and not owner-only. */
export function canAssume(item: PendingItem, now: number): boolean {
  return item.status === "open" && !item.ownerOnly && item.assumeAfter !== undefined && now >= item.assumeAfter && item.suggested.length > 0;
}
