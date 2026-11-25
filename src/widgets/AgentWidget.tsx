import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_WIDGET_HTML } from "../engine/fake/data.ts";
import { newRunId, useEngineData } from "../engine/hooks.ts";
import type { WidgetSource } from "../platform/index.ts";
import { useApp } from "../state/context.ts";
import { Modal } from "../ui/Modal.tsx";
import { tokensFor } from "../theme/tokensFor.ts";
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
      <p className="muted" data-testid="agent-widget-off">
        {source.off}
      </p>
    );
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
        srcDoc={source.srcdoc}
      />
    </div>
  );
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
