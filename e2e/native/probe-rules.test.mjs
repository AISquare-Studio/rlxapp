import { describe, expect, it } from "vitest";
import { agentVerdict, classifyHit, droppedRawMessages, evaluate, passed, redactKey, toMarkdown } from "./probe-rules.mjs";

const COMMANDS = ["app_info", "e2e_canary", "plugin:window|set_title"];
const rejected = (cmd) => ({ cmd, result: "rejected", message: `${cmd} not allowed by ACL` });

/** A report that passes on an OS with a widget webview and the switch off. */
function passingReport() {
  return {
    schema: 4,
    os: "macos",
    policy: { widgetWebview: true, builtins: "widgets", agentWidgets: "off: off until the probe passes" },
    proxy: { support: "deny-all", port: 4321, refused: 3 },
    switch: {
      agentRegister: "refused: agent-made widgets are off",
      builtinRegister: "registered: rlxwidget://localhost/e2e-builtin/1/",
      attach: "attached",
    },
    webviews: ["main", "widgets"],
    commandCount: COMMANDS.length,
    host: {
      done: true,
      href: "rlxwidget://localhost/host/",
      errors: [],
      channels: { tauriInternals: true },
      commands: COMMANDS.map(rejected),
      raw: [{ channel: "action-route (no token)", outcome: "response 403 actions are accepted only from the host page" }],
      connections: [{ kind: "off-machine", outcome: "added" }],
      ran: [{ frame: "e2e-builtin", id: "e2e-builtin" }],
      frames: [
        { id: "e2e-probe", sandbox: "allow-scripts" },
        { id: "e2e-builtin", sandbox: "allow-scripts" },
        { id: "e2e-agent", sandbox: "allow-scripts" },
      ],
      iframe: {
        origin: "null",
        initReceived: true,
        errors: [],
        sandbox: { parentDocument: "blocked: SecurityError", cookie: "blocked: SecurityError" },
        commands: [],
        raw: [{ channel: "action-route", outcome: "rejected Load failed" }],
        connections: [{ kind: "off-machine", outcome: "added" }],
        siblingInit: { siblings: 2, answered: [] },
      },
    },
    mount: { ok: true, ids: ["e2e-probe", "e2e-builtin"] },
    reload: { loadsBefore: 1, loadsAfter: 2, frames: ["e2e-probe", "e2e-builtin"] },
    framesBeforeNavigation: 2,
    hostAfterNavigation: {
      href: "rlxwidget://localhost/host/",
      frames: 2,
      navigation: { ack: ["http://127.0.0.1:1/widget-iframe/navigate"], violations: ["frame-src http://127.0.0.1:1"] },
    },
    main: {
      canary: { result: "resolved", value: 1 },
      frameSrc: "blocked: frame-src",
      actionRoute: "rejected Load failed",
      preconnect: "added",
      rtc: "gathering complete",
    },
    canary: [{ from: "main-control", webview: "main" }],
    actions: [{ widgetId: "e2e-builtin", message: { type: "refresh", v: 1 } }],
    listeners: {
      host: { selfTest: true, hits: [] },
      iframe: { selfTest: true, hits: [] },
      control: { selfTest: true, hits: ["1 udp 20 bytes (STUN/TURN)", "2 tcp connection, no data"] },
    },
    errors: [],
  };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.id);

/** Runs `fn` with RLX_PROBE_STRICT=1, as CI does. */
function strictly(fn) {
  const before = process.env.RLX_PROBE_STRICT;
  process.env.RLX_PROBE_STRICT = "1";
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RLX_PROBE_STRICT;
    else process.env.RLX_PROBE_STRICT = before;
  }
}

describe("isolation probe rules", () => {
  it("passes a clean report", () => {
    const checks = evaluate(passingReport());
    expect(failing(checks)).toEqual([]);
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(true);
  });

  it("refuses a report from another schema", () => {
    const report = passingReport();
    report.schema = 3;
    expect(failing(evaluate(report))).toEqual(["report"]);
  });

  it("fails when the widgets webview isn't behind the deny-all proxy where the OS has one", () => {
    const report = passingReport();
    const row = () => evaluate(report).find((c) => c.id === "widgets webview runs behind the deny-all proxy");
    expect(row().detail).toBe("127.0.0.1:4321, refused 3 connection(s)");
    report.proxy.port = null;
    expect(row().ok).toBe(false);
    expect(row().detail).toBe("this OS has the proxy, but it isn't running");
    expect(passed(evaluate(report))).toBe(false);
  });

  it("gates on off-machine preconnects reaching only the deny-all proxy", () => {
    const id = "preconnect and dns-prefetch off the machine reach only the deny-all proxy";
    const report = passingReport();
    expect(evaluate(report).find((c) => c.id === id)).toMatchObject({
      ok: true,
      detail: "the proxy refused 3; host page attempted, widget iframe attempted",
    });
    // The proxy refused nothing: the attempts went past it.
    report.proxy.refused = 0;
    let checks = evaluate(report);
    expect(failing(checks)).toEqual([id]);
    expect(agentVerdict(checks).mayTurnOn).toBe(false);
    // A side that never attempted proves nothing.
    report.proxy.refused = 3;
    report.host.iframe.connections = [];
    checks = evaluate(report);
    expect(failing(checks)).toEqual([id]);
    expect(checks.find((c) => c.id === id).detail).toBe("the proxy refused 3; host page attempted, widget iframe didn't attempt");
  });

  it("keeps agent-made widgets off where the OS has no per-webview proxy (macOS 13), and fails in strict mode", () => {
    const report = passingReport();
    report.proxy = { support: "unavailable: WebKit has no per-webview proxy before macOS 14", port: null, refused: 0 };
    const checks = evaluate(report);
    expect(failing(checks)).toEqual([
      "widgets webview runs behind the deny-all proxy",
      "preconnect and dns-prefetch off the machine reach only the deny-all proxy",
    ]);
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(false);
    strictly(() => {
      expect(passed(evaluate(report))).toBe(false);
      expect(passed(evaluate(passingReport()))).toBe(true);
    });
  });

  it("records a loopback preconnect as the documented residual on macOS, where off-machine preconnect is the gate", () => {
    const report = passingReport();
    report.listeners.host.hits = ["1 tcp connection, no data", "2 tcp connection, no data"];
    report.listeners.iframe.hits = ["1 tcp connection, no data"];
    const checks = evaluate(report);
    const residual = checks.filter((c) => c.id.endsWith("loopback preconnect/dns-prefetch (documented macOS residual)"));
    expect(residual.map((c) => [c.id, c.info])).toEqual([
      ["host page: loopback preconnect/dns-prefetch (documented macOS residual)", true],
      ["widget iframe: loopback preconnect/dns-prefetch (documented macOS residual)", true],
    ]);
    expect(residual[0].detail).toMatch(/^2 TCP connection\(s\) that sent nothing: preconnect ×2\. macOS never proxies loopback/);
    expect(checks.some((c) => c.id.endsWith(": 0 preconnect/dns-prefetch connections"))).toBe(false);
    expect(failing(checks)).toEqual([]);
    expect(agentVerdict(checks).mayTurnOn).toBe(true);
    strictly(() => expect(passed(evaluate(report))).toBe(true));
    // The off-machine gate still holds there: nothing refused means the attempts left the Mac.
    report.proxy.refused = 0;
    expect(failing(evaluate(report))).toEqual(["preconnect and dns-prefetch off the machine reach only the deny-all proxy"]);
    strictly(() => expect(passed(evaluate(report))).toBe(false));
  });

  it("keeps a loopback preconnect a gate on Windows and Linux", () => {
    for (const os of ["windows", "linux"]) {
      const report = passingReport();
      report.os = os;
      report.listeners.iframe.hits = ["1 tcp connection, no data"];
      const checks = evaluate(report);
      expect(failing(checks)).toEqual(["widget iframe: 0 preconnect/dns-prefetch connections"]);
      expect(checks.some((c) => c.id.includes("documented macOS residual"))).toBe(false);
      expect(passed(checks)).toBe(true);
      expect(agentVerdict(checks).mayTurnOn).toBe(false);
      strictly(() => expect(passed(evaluate(report))).toBe(false));
    }
  });

  it("fails when main's preconnect doesn't reach the control listener (main behind the proxy)", () => {
    const report = passingReport();
    const id = "main's networking unchanged: its preconnect reaches the control listener";
    expect(evaluate(report).find((c) => c.id === id).detail).toBe("1 preconnect connection(s); main added");
    report.listeners.control.hits = ["1 udp 20 bytes (STUN/TURN)"];
    expect(failing(evaluate(report))).toContain(id);
    expect(passed(evaluate(report))).toBe(false);
  });

  it("fails when a widget's canary call is recorded", () => {
    const report = passingReport();
    report.canary.push({ from: "widget-iframe-raw-chrome", webview: "widgets" });
    expect(failing(evaluate(report))).toContain("canary: 0 calls from widgets");
  });

  it("fails without the canary's positive control", () => {
    const report = passingReport();
    report.canary = [];
    expect(passed(evaluate(report))).toBe(false);
  });

  it("fails when a host command is not rejected by the ACL", () => {
    const report = passingReport();
    report.host.commands[2] = { cmd: "plugin:window|set_title", result: "rejected", message: "invalid args `title`" };
    expect(failing(evaluate(report))).toContain("host page: every command rejected");
    report.host.commands[2] = { cmd: "plugin:window|set_title", result: "resolved", message: "null" };
    expect(failing(evaluate(report))).toContain("host page: every command rejected");
  });

  it("calls unanswered iframe commands 'no command ran', never 'rejected'", () => {
    const report = passingReport();
    // Windows: WebView2 gives the iframe a keyed invoke(), and every call goes unanswered.
    report.host.iframe.commands = Array.from({ length: 174 }, (_, i) => ({
      cmd: i === 0 ? "e2e_canary" : `cmd_${i}`,
      result: "timeout",
      message: "no response in 6000 ms",
    }));
    const row = evaluate(report).find((c) => c.id === "widget iframe: no command ran");
    expect(row.ok).toBe(true);
    expect(row.detail).toBe("174 unanswered; canary 0, including the iframe's own canary call");
    expect(evaluate(report).some((c) => c.id === "widget iframe: every command rejected")).toBe(false);
    // A resolved call, or a canary call from the iframe, fails the row.
    report.host.iframe.commands.push({ cmd: "app_info", result: "resolved", message: "{}" });
    expect(failing(evaluate(report))).toContain("widget iframe: no command ran");
    report.host.iframe.commands.pop();
    report.canary.push({ from: "widget-iframe-invoke", webview: "widgets" });
    expect(failing(evaluate(report))).toContain("widget iframe: no command ran");
  });

  it("never fails on raw channels merely existing", () => {
    const report = passingReport();
    report.host.iframe.channels = { tauriInternals: true, chromeWebview: true, webkitIpc: true };
    expect(passed(evaluate(report))).toBe(true);
  });

  it("fails hard on a fetch or WebRTC connection, and gates on a preconnect (Windows)", () => {
    const report = passingReport();
    report.os = "windows";
    report.listeners.iframe.hits = ["1 tcp GET /widget-iframe/fetch HTTP/1.1"];
    expect(passed(evaluate(report))).toBe(false);
    report.listeners.iframe.hits = ["1 udp 20 bytes (STUN/TURN)"];
    expect(passed(evaluate(report))).toBe(false);

    report.listeners.iframe.hits = ["1 tcp connection, no data"];
    const gated = evaluate(report);
    expect(passed(gated)).toBe(true);
    expect(agentVerdict(gated).mayTurnOn).toBe(false);
    expect(toMarkdown("probe", gated)).toContain("must stay **off**");

    report.policy.agentWidgets = "on";
    report.switch.agentRegister = "registered: rlxwidget://localhost/e2e-agent/1/";
    report.host.ran.push({ frame: "e2e-agent", id: "e2e-agent" });
    expect(passed(evaluate(report))).toBe(false);
  });

  it("fails when the agent switch is off but the agent widget ran or registered", () => {
    const report = passingReport();
    report.host.ran.push({ frame: "e2e-agent", id: "e2e-agent" });
    expect(failing(evaluate(report))).toContain("refused agent-made widget never ran");
    const registered = passingReport();
    registered.switch.agentRegister = "registered: rlxwidget://localhost/e2e-agent/1/";
    expect(failing(evaluate(registered))).toContain("agent-made widgets switch honoured");
  });

  it("fails when a sibling's fake init is answered", () => {
    const report = passingReport();
    report.host.iframe.siblingInit.answered = ['{"type":"refresh","v":1}'];
    expect(failing(evaluate(report))).toContain("a sibling frame can't init another widget");
  });

  it("fails when the host page navigated away", () => {
    const report = passingReport();
    report.hostAfterNavigation = null;
    expect(failing(evaluate(report))).toContain("host page stays on the widget scheme after navigating");
  });

  it("fails hard on any frame navigation request, on every OS and policy", () => {
    for (const vector of ["navigate", "ping-target", "meta-refresh"]) {
      const report = passingReport();
      // Windows-like: a webview only the probe attached, where connection leaks are gates.
      report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview in v0" };
      report.switch.attach = "refused: this OS has no widget webview in v0";
      report.switch.builtinRegister = "refused: this OS has no widget webview in v0";
      report.switch.probeAttach = "attached for the probe only";
      report.listeners.iframe.hits = [`1 tcp GET /widget-iframe/${vector} HTTP/1.1`];
      const checks = evaluate(report);
      expect(passed(checks)).toBe(false);
      expect(failing(checks)).toContain("widget frame can't navigate off the widget scheme (navigate, link, meta refresh, top, popup, form)");
    }
  });

  it("fails when the fixture's navigation step never ran", () => {
    const report = passingReport();
    report.hostAfterNavigation.navigation = { ack: null, violations: [] };
    expect(failing(evaluate(report))).toContain("the fixture's navigation step ran (positive control)");
  });

  it("checks the switch on an OS without a widget webview", () => {
    const report = passingReport();
    report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview" };
    report.switch = {
      agentRegister: "refused: agent-made widgets are off",
      builtinRegister: "refused: this OS has no widget webview in v0",
      attach: "refused: this OS has no widget webview in v0",
      probeAttach: "not needed",
    };
    report.webviews = ["main"];
    report.host = null;
    report.actions = [];
    expect(failing(evaluate(report))).toEqual([]);
    expect(agentVerdict(evaluate(report)).mayTurnOn).toBe(false);
    expect(toMarkdown("probe", evaluate(report))).toContain("no widget webview in v0");
    report.webviews = ["main", "widgets"];
    expect(failing(evaluate(report))).toContain("no other webviews");
  });

  it("marks the canary n/a where no widget code ran (Linux), but still fails a stray call", () => {
    const report = passingReport();
    report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview" };
    report.switch = {
      agentRegister: "refused: agent-made widgets are off",
      builtinRegister: "refused: this OS has no widget webview in v0",
      attach: "refused: this OS has no widget webview in v0",
      probeAttach: "not needed",
    };
    report.webviews = ["main"];
    report.host = null;
    report.actions = [];
    report.proxy = { support: "deny-all", port: null, refused: 0 };
    report.listeners.control.hits = [];
    const row = evaluate(report).find((c) => c.id === "canary: 0 calls from widgets");
    expect(row.info).toBe(true);
    expect(row.detail).toBe("n/a: no widget surface on this OS");
    // No widgets webview ran, so neither the proxy nor main's preconnect is checked.
    expect(failing(evaluate(report))).toEqual([]);
    expect(evaluate(report).find((c) => c.id.startsWith("main's networking")).info).toBe(true);
    report.canary.push({ from: "somewhere", webview: "widgets" });
    expect(failing(evaluate(report))).toContain("canary: 0 calls from widgets");
  });

  it("probes a webview the product doesn't attach, when the probe attached one (Windows)", () => {
    const report = passingReport();
    report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview in v0" };
    report.switch.attach = "refused: this OS has no widget webview in v0";
    report.switch.builtinRegister = "refused: this OS has no widget webview in v0";
    report.switch.probeAttach = "attached for the probe only";
    expect(failing(evaluate(report))).toEqual([]);
    // A leak on a probe-only webview keeps Windows widgets off but doesn't fail the run...
    report.listeners.host.hits = ["1 tcp GET /widgets-host/navigate HTTP/1.1"];
    const gated = evaluate(report);
    expect(failing(gated)[0]).toMatch(/host page: 0 connections/);
    expect(passed(gated)).toBe(true);
    expect(agentVerdict(gated).mayTurnOn).toBe(false);
    // ...while the IPC rules stay hard there.
    report.canary.push({ from: "widget-iframe-raw-chrome", webview: "widgets" });
    expect(passed(evaluate(report))).toBe(false);
  });

  it("fails when a mount is reported before it happened, or a reload loses the grid", () => {
    const early = passingReport();
    early.mount = { ok: false, error: "the host page didn't answer the mount" };
    expect(failing(evaluate(early))).toContain("widgets_mount resolves once the host page has mounted");
    const lost = passingReport();
    lost.reload.frames = [];
    expect(failing(evaluate(lost))).toContain("a reload of the widgets webview restores the grid");
  });

  it("reads Tauri's dropped-key lines without keeping the key", () => {
    const line = "__TAURI_INVOKE_KEY__ expected 1234secret but received rlx-probe-widget-iframe-webkit";
    expect(redactKey(line)).not.toContain("1234secret");
    expect(droppedRawMessages(`x\n${line}\n`)).toEqual(["widget-iframe-webkit"]);
  });

  it("classifies listener hits", () => {
    expect(classifyHit("5 tcp GET /widgets-host/websocket HTTP/1.1").vector).toBe("websocket");
    expect(classifyHit("5 tcp 56 bytes (STUN/TURN)").vector).toBe("rtc");
    expect(classifyHit("5 tcp connection, no data").vector).toBe("preconnect");
  });
});
