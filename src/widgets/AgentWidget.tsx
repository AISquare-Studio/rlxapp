import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_WIDGET_HTML } from "../engine/fake/data.ts";
import { newRunId, useEngineData } from "../engine/hooks.ts";
import type { WidgetSource } from "../platform/index.ts";
import type { WidgetBounds } from "../platform/widgetHost.ts";
import { useApp } from "../state/context.ts";
import { Modal } from "../ui/Modal.tsx";
import { tokensFor } from "../theme/tokensFor.ts";
import { withColorScheme } from "./colorScheme.ts";
import { useOsDark } from "../theme/useOsDark.ts";

/**
 * The sandbox for agent-made widgets: scripts only. No allow-same-origin, so the document gets
 * an opaque origin with no access to the app's DOM, storage or IPC (architecture §5.3).
 */
export const AGENT_WIDGET_SANDBOX = "allow-scripts";

export interface AgentFrameProps {
  id: string;
  version: number;
  title: string;
  html: string;
  data: unknown;
}

/** Renders one agent-made widget in a sandboxed iframe and feeds it through a MessageChannel port. */
export function AgentFrame({ id, version, title, html, data }: AgentFrameProps) {
  const { platform, state } = useApp();
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const [source, setSource] = useState<WidgetSource | null>(null);
  const [ready, setReady] = useState(false);
  const [focused, setFocused] = useState(false);
  const latest = useRef(data);
  const osDark = useOsDark();
  const { family, mode, accent } = state.settings;
  const tokens = useMemo(() => tokensFor({ family, mode, accent }, osDark), [family, mode, accent, osDark]);
  const scheme = tokens["color-scheme"] === "light" ? "light" : "dark";
  const tokensRef = useRef(tokens);

  useEffect(() => {
    let active = true;
    platform
      .widgetSource(id, version, html)
      .then((next) => active && setSource(next))
      .catch((error: unknown) => console.error("widget source failed", error));
    return () => {
      active = false;
    };
  }, [platform, id, version, html]);

  useEffect(() => () => port.current?.close(), []);

  const onLoad = () => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    port.current?.close();
    const channel = new MessageChannel();
    port.current = channel.port1;
    let budget = 20;
    const refill = setInterval(() => (budget = 20), 1000);
    channel.port1.onmessage = (event: MessageEvent<{ type?: string; v?: number }>) => {
      // Validate and rate-limit every message (20/s); widgets may only say ready or ask to refresh.
      budget -= 1;
      if (budget < 0 || event.data?.v !== 1) return;
      if (event.data.type === "ready") {
        setReady(true);
        channel.port1.postMessage({ type: "data", v: 1, data: latest.current, fetchedAt: new Date().toISOString(), stale: false });
      }
    };
    channel.port1.addEventListener("close", () => clearInterval(refill));
    // The origin is opaque, so the target must be "*"; everything after this uses the port.
    target.postMessage({ type: "init", v: 1, widgetId: id, settings: {}, state: {}, theme: tokensRef.current }, "*", [channel.port2]);
  };

  useEffect(() => {
    latest.current = data;
    if (ready) port.current?.postMessage({ type: "data", v: 1, data, fetchedAt: new Date().toISOString(), stale: false });
  }, [data, ready]);

  useEffect(() => {
    tokensRef.current = tokens;
    if (ready) port.current?.postMessage({ type: "theme", v: 1, theme: tokens });
  }, [tokens, ready]);

  if (!source) return <p className="muted">Loading widget…</p>;
  if ("off" in source)
    return (
      <div className="agent-widget-off" data-testid="agent-widget-off">
        <p className="muted">Agent-made widgets are off here for now.</p>
        <details className="fold">
          <summary>Why</summary>
          <p className="muted" data-testid="agent-widget-off-reason">
            Agent-made widgets are {source.off}.
          </p>
        </details>
      </div>
    );
  if ("host" in source) return <HostedFrame id={source.host.id} version={source.host.version} title={title} data={data} />;
  return (
    <div className={`agent-frame-wrap${focused ? " is-focused" : ""}`}>
      <iframe
        ref={frame}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      className="agent-frame"
      title={title}
      sandbox={AGENT_WIDGET_SANDBOX}
      referrerPolicy="no-referrer"
      data-testid="agent-widget-frame"
      onLoad={onLoad}
        data-scheme={scheme}
        srcDoc={withColorScheme(source.srcdoc, scheme)}
      />
    </div>
  );
}

/** The widget's bounds in the window, in logical px: the main webview fills the window. */
function boundsOf(el: HTMLElement): WidgetBounds {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * An agent-made widget in the widget host (architecture §5.3): this tile keeps an empty slot,
 * and the `widgets` child webview is placed over it, mounted and fed through the core. The
 * slot's bounds follow resizes and scrolling; the webview hides while something covers Home.
 */
function HostedFrame({ id, version, title, data }: { id: string; version: number; title: string; data: unknown }) {
  const { platform } = useApp();
  const host = platform.widgetHost;
  const [mounted, setMounted] = useState(false);
  const slot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = slot.current;
    if (!host || !el) return undefined;
    let active = true;
    const place = () => void host.place(boundsOf(el));
    place();
    void host
      .mount([{ id, version, title }])
      .then((ids) => active && setMounted(ids.includes(id)))
      .catch((error: unknown) => console.error("widget mount failed", error));
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(el);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      active = false;
      resize?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      void host.place(null);
    };
  }, [host, id, version, title]);

  useEffect(() => {
    if (host && mounted) void host.push(id, data).catch((error: unknown) => console.error("widget push failed", error));
  }, [host, mounted, id, data]);

  return <div className="agent-host-slot" ref={slot} data-testid="agent-widget-host-slot" aria-label={title} role="region" />;
}

/** The built-in example of an agent-made widget: open pull requests per repository. */
export function AgentWidget({ id, title, html }: { id: string; title: string; html?: string }) {
  const { data } = useEngineData<unknown>(
    "widget_refresh",
    "Count open pull requests per repository, and how many are in review",
    { kind: "no_tools" },
    15,
  );
  return <AgentFrame id={id} version={1} title={title} html={html ?? AGENT_WIDGET_HTML} data={data ?? []} />;
}

/** The mock flow behind "Ask <Agent> to make a widget": a WidgetAuthor run, a preview, then Add. */
export function AskAgentFlow({ onClose, onAdd }: { onClose: () => void; onAdd: (title: string, html: string) => void }) {
  const { engine, state } = useApp();
  const [prompt, setPrompt] = useState("A widget with my open pull requests");
  const [phase, setPhase] = useState<"ask" | "building" | "preview">("ask");
  const [result, setResult] = useState<{ title: string; html: string } | null>(null);
  const agent = state.settings.agentName;

  const build = async () => {
    setPhase("building");
    const id = await engine.run({
      id: newRunId(),
      kind: "widget_author",
      prompt,
      mount: { kind: "no_tools" },
      needsConnectors: [],
      persist: false,
    });
    const off = engine.attach(id, 1, ({ event }) => {
      if (event.type !== "finished") return;
      off();
      const output = event.output as { html: string } | undefined;
      setResult({ title: prompt, html: output?.html ?? AGENT_WIDGET_HTML });
      setPhase("preview");
    });
  };

  return (
    <Modal
      title={`Ask ${agent} to make a widget`}
      onClose={onClose}
      footer={
        phase === "preview" && result ? (
          <>
            <button type="button" className="button" onClick={() => setPhase("ask")}>
              Change request
            </button>
            <button type="button" className="button button--primary" onClick={() => onAdd(result.title, result.html)}>
              Add to Home
            </button>
          </>
        ) : (
          <button type="button" className="button button--primary" disabled={phase === "building" || !prompt.trim()} onClick={() => void build()}>
            {phase === "building" ? `${agent} is building…` : "Make it"}
          </button>
        )
      }
    >
      {phase === "preview" && result ? (
        <div className="preview">
          <p className="muted">Preview with one dry-run refresh. It renders in a sandbox with no network or app access.</p>
          <div className="preview__frame">
            <AgentWidget id="preview" title={result.title} html={result.html} />
          </div>
        </div>
      ) : (
        <label className="field">
          <span>What should it show?</span>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={phase === "building"} />
        </label>
      )}
      {phase === "building" ? (
        <div className="progress" role="progressbar" aria-label="Building the widget">
          <div className="progress__bar" />
        </div>
      ) : null}
    </Modal>
  );
}
