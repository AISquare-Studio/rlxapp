/**
 * The Engine interface: the UI's only boundary to agentic work.
 *
 * A TypeScript mirror of the `Engine` trait and its types in docs/architecture.md §2. The real
 * `RlxEngine` lives in the Rust core and talks to rlxd; the UI shell runs on `FakeEngine`
 * (./fake/), which implements the same shapes with scripted, mock data.
 */

export type RunId = string;

export type RunKind =
  | "task"
  | "widget_refresh"
  | "watch"
  | "check"
  | "send_executor"
  | "widget_author"
  | "parse_instruction";

export type ConnectorStatus = "connected" | "needs-auth" | "pending" | "failed";

export interface Connector {
  id: string;
  status: ConnectorStatus;
  tools: { name: string; access: "read" | "write" | "unknown" }[];
}

/** Which tools a run mounts: none (`--tools "" --strict-mcp-config`), or named connectors. */
export type Mount = { kind: "no_tools" } | { kind: "connectors"; connectors: string[] };

export interface RunRequest {
  /** Chosen by the core; also Claude Code's `--session-id`. */
  id: RunId;
  kind: RunKind;
  prompt: string;
  mount: Mount;
  /** Must be "connected" in system/init before the first turn. */
  needsConnectors: string[];
  outputSchema?: unknown;
  /** false = `--no-session-persistence`; only Tasks persist. */
  persist: boolean;
}

export interface ToolCall {
  tool: string;
  input: unknown;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "draft"; draft: string };

/** Sees every tool call; an unreachable gate means deny. Fixed when the engine is built. */
export interface ToolGate {
  decide(run: RunId, call: ToolCall): Promise<Decision>;
}

export interface Seq<T> {
  seq: number;
  event: T;
}

export type RunStatus = "done" | "failed" | "cancelled";

export type RunEvent =
  | { type: "started"; connectors: [string, ConnectorStatus][] }
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; tool: string; raw: unknown }
  | { type: "rate_limited"; until?: string }
  | { type: "question"; text: string }
  | { type: "finished"; status: RunStatus; output?: unknown; reason?: string };

/** The UI's view of a run's lifecycle (architecture §6). */
export type RunState = "queued" | "running" | "needs-you" | "done" | "failed";

export interface RunSummary {
  id: RunId;
  kind: RunKind;
  state: RunState;
  /** A display title, the prompt's first line. */
  title: string;
  startedAt: number;
  lastSeq: number;
  failureReason?: string;
}

export type EngineStatus =
  | { kind: "not-installed" }
  | { kind: "installing"; pct: number }
  | { kind: "incompatible"; protocol: number }
  | { kind: "signed-out" }
  | { kind: "ready"; account: string; plan: string };

export type SignInStep =
  | { kind: "open-url"; url: string }
  | { kind: "waiting" }
  | { kind: "signed-in"; account: string }
  | { kind: "error"; message: string };

export interface EngineInfo {
  protocolVersion: number;
  engineVersion: string;
  capabilities: string[];
}

export type Unsubscribe = () => void;

/**
 * Settings that live with the host's rlx, not in the app (rlxd's settings API, handoff
 * addendum §4): every client of that host sees the same values and their changes.
 */
export interface HostSettings {
  /** The rlx service's own login registration (LaunchAgent / systemd user unit / logon task). */
  startAtLogin: boolean;
  /** The service's one menu-bar / tray icon: rlx's '\' in colour, or a monochrome template. */
  serviceTrayIcon: "color" | "template";
}

export interface Engine {
  /** The protocol-version handshake. */
  hello(): Promise<EngineInfo>;
  status(): Promise<EngineStatus>;
  /** Streams open-url, waiting, then signed-in or error. */
  signIn(onStep: (step: SignInStep) => void): Promise<void>;
  connectors(): Promise<Connector[]>;
  run(req: RunRequest): Promise<RunId>;
  /** Everything the engine knows, live or ended. */
  runs(): Promise<RunSummary[]>;
  /** Replays a run's events from `fromSeq`, then follows live. */
  attach(run: RunId, fromSeq: number, onEvent: (event: Seq<RunEvent>) => void): Unsubscribe;
  /** Only for runs the engine reports dead or waiting on the owner. */
  resume(run: RunId, reply?: string): Promise<void>;
  cancel(run: RunId): Promise<void>;
  /** Fires when any run's summary changes, so lists can re-read `runs()`. */
  onRunsChanged(listener: () => void): Unsubscribe;
  /** This host's settings. */
  hostSettings(): Promise<HostSettings>;
  /** Changes some of this host's settings and resolves with all of them. */
  updateHostSettings(patch: Partial<HostSettings>): Promise<HostSettings>;
  /** Fires when this host's settings change, from any client. */
  onHostSettingsChanged(listener: (settings: HostSettings) => void): Unsubscribe;
}

/** Developer mode's reads (architecture §9): rlx's fleet, board and panes, through the engine. */
export type AgentState = "live" | "waiting" | "paused" | "exited" | "lost";

export interface FleetAgent {
  id: string;
  label: string;
  role: "manager" | "coder" | "tester" | "reviewer";
  project: string;
  state: AgentState;
  account: string;
  task?: string;
}

export interface BoardTask {
  id: string;
  title: string;
  status: "todo" | "doing" | "review" | "blocked" | "done";
  owner?: string;
}

export interface DeveloperEngine {
  fleet(): Promise<FleetAgent[]>;
  board(): Promise<BoardTask[]>;
  /** A read-only pane's text; `onFrame` fires with each new screen. */
  watchPane(agentId: string, onFrame: (text: string) => void): Unsubscribe;
  /** Hands off to `rlx ui` in the user's terminal. */
  openInTerminal(): Promise<void>;
}
