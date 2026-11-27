import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../state/context.ts";
import type { HostSettings, Mount, RunEvent, RunKind, RunSummary, Seq } from "./types.ts";

let runCounter = 0;

/** A run id the core chooses (and Claude Code's --session-id). */
export function newRunId(): string {
  runCounter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${runCounter}`;
  return random;
}

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

export interface EngineData<T> {
  data: T | null;
  status: "refreshing" | "ok" | "error";
  fetchedAt: number | null;
  refresh: () => void;
}

/**
 * A widget's data job: one engine run whose finished output is the data (architecture §5.1).
 * Invalid or failed output keeps the last good data and reports `error`.
 */
export function useEngineData<T>(kind: RunKind, prompt: string, mount: Mount, everyMin?: number): EngineData<T> {
  const { engine, now } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<EngineData<T>["status"]>("refreshing");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const stop = useRef<() => void>(() => {});
  const mountKey = JSON.stringify(mount);

  /** Starts one refresh run and follows it to its finished event. */
  const start = useCallback(() => {
    stop.current();
    let active = true;
    let finished = false;
    let off: () => void = () => {};
    const id = newRunId();
    stop.current = () => {
      active = false;
      off();
      // A refresh nobody waits for any more is cancelled, not left to spend a turn.
      if (!finished) void engine.cancel(id).catch(() => {});
    };
    const parsedMount = JSON.parse(mountKey) as Mount;
    const needs = parsedMount.kind === "connectors" ? parsedMount.connectors : [];
    engine
      .run({ id, kind, prompt, mount: parsedMount, needsConnectors: needs, persist: false })
      .then(() => {
        if (!active) {
          if (!finished) void engine.cancel(id).catch(() => {});
          return;
        }
        off = engine.attach(id, 1, ({ event }) => {
          if (event.type === "finished") finished = true;
          if (!active || event.type !== "finished") return;
          if (event.status === "done" && event.output !== undefined && event.output !== null) {
            setData(event.output as T);
            setFetchedAt(now());
            setStatus("ok");
          } else {
            setStatus("error");
          }
        });
      })
      .catch(() => active && setStatus("error"));
  }, [engine, kind, prompt, mountKey, now]);

  useEffect(() => {
    start();
    const timer = everyMin ? setInterval(start, everyMin * 60_000) : undefined;
    return () => {
      stop.current();
      if (timer) clearInterval(timer);
    };
  }, [start, everyMin]);

  const refresh = useCallback(() => {
    setStatus("refreshing");
    start();
  }, [start]);
  return { data, status, fetchedAt, refresh };
}

/**
 * This host's settings from the engine (rlxd's settings API), kept live: a change from any
 * client shows here. `update` writes through the engine; nothing is stored in the app.
 */
export function useHostSettings(): { settings: HostSettings | null; update: (patch: Partial<HostSettings>) => Promise<void> } {
  const { engine } = useApp();
  const [settings, setSettings] = useState<HostSettings | null>(null);
  useEffect(() => {
    let active = true;
    engine
      .hostSettings()
      .then((next) => active && setSettings(next))
      .catch((error: unknown) => console.error("hostSettings() failed", error));
    const off = engine.onHostSettingsChanged((next) => active && setSettings(next));
    return () => {
      active = false;
      off();
    };
  }, [engine]);
  const update = useCallback(
    async (patch: Partial<HostSettings>) => {
      setSettings(await engine.updateHostSettings(patch));
    },
    [engine],
  );
  return { settings, update };
}
