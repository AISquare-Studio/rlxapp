/**
 * How many main-window overlays (modals, menus) are open. Home hides the widget host's tiles
 * while any is open, so a native child webview never paints over them (follow-up 7).
 */
import { useSyncExternalStore } from "react";

let open = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Marks one overlay open; call the result when it closes. */
export function openOverlay(): () => void {
  open += 1;
  emit();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open = Math.max(0, open - 1);
    emit();
  };
}

export function useOverlayCount(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
