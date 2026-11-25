import { describe, expect, it } from "vitest";
import { agentVerdict, classifyHit, droppedRawMessages, evaluate, passed, redactKey, toMarkdown } from "./probe-rules.mjs";

const COMMANDS = ["app_info", "e2e_canary", "plugin:window|set_title"];
const rejected = (cmd) => ({ cmd, result: "rejected", message: `${cmd} not allowed by ACL` });

/** A report that passes on an OS with a widget webview and the switch off. */
function passingReport() {
  return {
    schema: 3,
    os: "macos",
    policy: { widgetWebview: true, builtins: "widgets", agentWidgets: "off: off until the probe passes" },
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
      connections: [],
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
        connections: [],
      },
    },
    mount: { ok: true, ids: ["e2e-probe", "e2e-builtin"] },
    reload: { loadsBefore: 1, loadsAfter: 2, frames: ["e2e-probe", "e2e-builtin"] },
    framesBeforeNavigation: 2,
    hostAfterNavigation: { href: "rlxwidget://localhost/host/", frames: 2 },
    main: { canary: { result: "resolved", value: 1 }, frameSrc: "blocked: frame-src", actionRoute: "rejected Load failed", rtc: "gathering complete" },
    canary: [{ from: "main-control", webview: "main" }],
    actions: [{ widgetId: "e2e-builtin", message: { type: "refresh", v: 1 } }],
    listeners: {
      host: { selfTest: true, hits: [] },
      iframe: { selfTest: true, hits: [] },
      control: { selfTest: true, hits: ["1 udp 20 bytes (STUN/TURN)"] },
    },
    errors: [],
  };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.id);

describe("isolation probe rules", () => {
  it("passes a clean report", () => {
    const checks = evaluate(passingReport());
    expect(failing(checks)).toEqual([]);
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(true);
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

  it("accepts silence from the iframe but not a resolved command", () => {
    const report = passingReport();
    report.host.iframe.commands = [{ cmd: "app_info", result: "timeout", message: "no response" }];
    expect(passed(evaluate(report))).toBe(true);
    report.host.iframe.commands.push({ cmd: "e2e_canary", result: "resolved", message: "1" });
    expect(failing(evaluate(report))).toContain("widget iframe: every command rejected");
  });

  it("never fails on raw channels merely existing", () => {
    const report = passingReport();
    report.host.iframe.channels = { tauriInternals: true, chromeWebview: true, webkitIpc: true };
    expect(passed(evaluate(report))).toBe(true);
  });

  it("fails hard on a fetch or WebRTC connection, and gates on a preconnect", () => {
    const report = passingReport();
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

  it("fails when the host page navigated away", () => {
    const report = passingReport();
    report.hostAfterNavigation = null;
    expect(failing(evaluate(report))).toContain("self-navigation off the widget scheme blocked");
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
    report.webviews = ["main", "widgets"];
    expect(failing(evaluate(report))).toContain("no other webviews");
  });

  it("probes a webview the product doesn't attach, when the probe attached one (Windows)", () => {
    const report = passingReport();
    report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview in v0" };
    report.switch.attach = "refused: this OS has no widget webview in v0";
    report.switch.builtinRegister = "refused: this OS has no widget webview in v0";
    report.switch.probeAttach = "attached for the probe only";
    expect(failing(evaluate(report))).toEqual([]);
    report.listeners.iframe.hits = ["1 tcp GET /widget-iframe/navigate HTTP/1.1"];
    expect(failing(evaluate(report))[0]).toMatch(/widget iframe: 0 connections/);
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
