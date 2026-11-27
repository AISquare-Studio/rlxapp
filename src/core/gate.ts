/**
 * The send gate's rule (architecture §8): what may send a draft, and as whom. The core enforces
 * it in `Core.send`; screens read the same rule to show the one primary action.
 */
import type { Draft, SendMode, Settings, StandingApproval } from "../state/model.ts";

/** Auto's hold before a send goes out, with Undo. */
export const HOLD_MS = 10_000;

export interface SendCheck {
  mode: SendMode;
  /** An active standing approval covers this connector and destination. */
  covered: boolean;
  /** Send is allowed now (or, on Auto, after the hold). */
  canSend: boolean;
}

export function sendCheck(draft: Draft, settings: Pick<Settings, "sendModes">, approvals: StandingApproval[]): SendCheck {
  const mode = settings.sendModes[draft.connector] ?? "draft";
  const covered = approvals.some((a) => a.status === "active" && a.connector === draft.connector && a.destination === draft.destination);
  const canSend = draft.status === "approved" || mode === "auto" || (mode === "preapproved" && covered);
  return { mode, covered, canSend };
}

/** What `Core.send` did: sent now, held for Auto's 10 seconds, or refused (it needs the owner). */
export type SendResult = "sent" | "held" | "refused";
