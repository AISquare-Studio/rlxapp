import { useCallback, useEffect, useState } from "react";
import { useApp } from "../state/context.ts";
import type { WidgetInstance } from "../state/model.ts";
import type { HostSettings, RunEvent, RunSummary, Seq } from "./types.ts";

export { newRunId } from "../core/ids.ts";

/** Every run the engine knows, re-read whenever one changes. */
export function useRuns(): RunSummary[] {
  const { engine } = useApp();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    let active = true;
    const read = () => {
      engine
        .runs()
        .then((next) => active && setRuns(next))
        .catch((error: unknown) => console.error("runs() failed", error));
    };
    read();
    const off = engine.onRunsChanged(read);
    return () => {
      active = false;
      off();
    };
  }, [engine]);
  return runs;
}

/** A run's events from the first, following live. */
export function useRunEvents(runId: string | undefined): Seq<RunEvent>[] {
  const { engine } = useApp();
  const [store, setStore] = useState<{ id?: string; events: Seq<RunEvent>[] }>({ events: [] });
  useEffect(() => {
    if (!runId) return undefined;
    return engine.attach(runId, 1, (event) => {
      setStore((prev) => {
        const events = prev.id === runId ? prev.events : [];
        if (events.some((e) => e.seq === event.seq)) return prev;
        return { id: runId, events: [...events, event] };
      });
    });
  }, [engine, runId]);
  return store.id === runId ? store.events : [];
}

/** The current time, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const { now } = useApp();
  const [value, setValue] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setValue(now()), ms);
    return () => clearInterval(timer);
  }, [ms, now]);
  return value;
}

export interface WidgetDataView<T> {
  data: T | null;
  status: "refreshing" | "ok" | "error";
  fetchedAt: number | null;
  refresh: () => void;
}

/**
 * A widget's data, from the core's data job for it (architecture §5.1): watching starts the job
 * (a refresh now, then on its interval) and leaving stops it. A failed refresh keeps the last
 * good data and reports `error`.
 */
export function useWidgetData<T>(widget: WidgetInstance): WidgetDataView<T> {
  const { core, state } = useApp();
  const key = JSON.stringify(widget);
  useEffect(() => core.watchWidget(JSON.parse(key) as WidgetInstance), [core, key]);
  const entry = state.widgetData[widget.id];
  const refresh = useCallback(() => void core.refreshWidget(widget.id), [core, widget.id]);
  return { data: (entry?.data as T | null | undefined) ?? null, status: entry?.status ?? "refreshing", fetchedAt: entry?.fetchedAt ?? null, refresh };
}

/**
 * The rlx service's settings (start at login, its tray icon), through the core, which reads and
 * writes them with the engine (rlxd's settings API) and follows changes from any client.
 * Nothing is stored in the app.
 */
export function useHostSettings(): { settings: HostSettings | null; update: (patch: Partial<HostSettings>) => Promise<void> } {
  const { core, state } = useApp();
  const update = useCallback((patch: Partial<HostSettings>) => core.updateServiceSettings(patch), [core]);
  return { settings: state.service, update };
}
