let counter = 0;
let runCounter = 0;

/** A fresh id for a message, draft, card or notice. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** A run id the core chooses (and Claude Code's --session-id). */
export function newRunId(): string {
  runCounter += 1;
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${runCounter}`;
}
