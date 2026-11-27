import { describe, expect, it } from "vitest";
import { agentVerdict, authorityKey, classifyHit, droppedRawMessages, evaluate, passed, readProxyLog, redactKey, toMarkdown } from "./probe-rules.mjs";

const COMMANDS = ["app_info", "e2e_canary", "plugin:window|set_title"];
const rejected = (cmd) => ({ cmd, result: "rejected", message: `${cmd} not allowed by ACL` });

const LAN = "192.168.1.20";
const SIDE_NAMES = ["widgets-host", "widget-iframe", "main"];
const MACOS_RESIDUAL = ["loopback-v4", "localhost", "loopback-v6", "own-lan-address", "link-local-v4"];

/** A side's reach plan, as src-tauri/src/e2e/reach.rs builds it. */
function sidePlan(index, { dns = false } = {}) {
  const side = SIDE_NAMES[index];
  const targets =
    side === "main"
      ? [["test-net", "off-machine", "198.51.100.9"]]
      : [
          ["loopback-v4", "on-host", "127.0.0.1"],
          ["localhost", "on-host", "localhost"],
          ["sub-localhost", "on-host", `rlx-${side}.localhost`],
          ["loopback-v6", "on-host", "[::1]"],
          ["own-lan-address", "on-host", LAN],
          ["lan-peer", "off-host", "192.168.1.254"],
          ["link-local-v4", "off-host", "169.254.77.77"],
          ["link-local-v6", "off-host", "[fe80::77]"],
          ["rfc1918-10", "off-host", "10.255.255.1"],
          ["ula", "off-host", "[fd00::77]"],
          ["mdns-name", "off-host", `rlx-${side}.local`],
          ["test-net", "off-machine", index === 0 ? "198.51.100.7" : "198.51.100.8"],
          ["canary-name", "off-machine", `${side}.rlx-probe-canary.invalid`],
        ];
  const list = targets.map(([id, cls, host]) => [id, cls, host, "preconnect"]);
  if (dns) {
    list.push(["dns-name", "off-machine", `${side}.rlx-probe-dns.test`, "preconnect"]);
    list.push(["dns-prefetch", "off-machine", `${side}-prefetch.rlx-probe-dns.test`, "dns-prefetch"]);
  }
  const plan = [];
  list.forEach(([id, cls, host, rel], i) => {
    const schemes = rel === "preconnect" ? ["http", "https"] : ["http"];
    schemes.forEach((scheme, offset) => {
      const port = cls === "on-host" ? 5000 + 1000 * offset + index : 41000 + 1000 * index + 2 * i + offset;
      plan.push({ id, class: cls, rel, scheme, host, port, authority: `${host}:${port}`, url: `${scheme}://${host}:${port}/${side}/${id}` });
    });
  });
  return plan;
}

/**
 * The reach parts of a report on `os`, as a clean run produces them. On macOS, Network.framework
 * CONNECTs every proxied target (IPv6 without brackets) and the residual goes direct; on
 * Windows, Chromium CONNECTs https and sends nothing on an http preconnect through the proxy.
 */
function reachParts(os, { dns = false, silent = false } = {}) {
  const plans = [0, 1, 2].map((index) => sidePlan(index, { dns }));
  const starts = [100_000, 50_000, 10_000];
  const tried = plans.map((plan, index) => plan.map((attempt, i) => ({ ...attempt, at: starts[index] + 250 * i })));
  const log = [];
  const hits = [[], []];
  for (const side of [0, 1]) {
    for (const attempt of tried[side]) {
      if (attempt.rel !== "preconnect") continue;
      if (os === "macos" && MACOS_RESIDUAL.includes(attempt.id)) {
        if (attempt.class === "on-host") {
          const address = attempt.id === "loopback-v6" ? "::1" : attempt.id === "own-lan-address" ? LAN : "127.0.0.1";
          const sni = attempt.id === "localhost" ? "sni=localhost" : "no sni";
          hits[side].push(`${attempt.at + 3} tcp@${address} ${attempt.scheme === "http" ? "connection, no data" : `tls ClientHello, ${sni}`}`);
        }
        continue;
      }
      if (silent) continue;
      const authority = os === "macos" ? attempt.authority.replace(/^\[([^\]]+)\]/, "$1") : attempt.authority;
      log.push(os !== "macos" && attempt.scheme === "http" ? `${attempt.at + 5} no data` : `${attempt.at + 5} CONNECT ${authority} HTTP/1.1`);
    }
  }
  const queries = dns ? [`${starts[2] + 300} A main.rlx-probe-dns.test`, `${starts[2] + 600} A main-prefetch.rlx-probe-dns.test`] : [];
  // Windows' netstat witness sees main's direct attempts to its TEST-NET address.
  const netstat =
    os === "windows"
      ? { samples: 200, errors: 0, synSent: tried[2].filter((a) => a.id === "test-net").map((a) => `${a.at + 3} ${a.authority}`).concat([`1 20.1.2.3:443`]) }
      : undefined;
  return {
    plans,
    tried,
    log,
    hits,
    netstat,
    dns: dns ? { zone: "rlx-probe-dns.test", port: 53535, queries } : null,
  };
}

/** Puts `os`'s clean reach parts into `report`. */
function withReach(report, os, { dns = false, silent = false } = {}) {
  const parts = reachParts(os, { dns, silent });
  report.os = os;
  if (os !== "macos") report.policy = { ...report.policy, agentWidgetsEligibility: "eligible", residual: null };
  if (parts.netstat) report.netstat = parts.netstat;
  report.reach = { lan: LAN, plans: { "widgets-host": parts.plans[0], "widget-iframe": parts.plans[1], main: parts.plans[2] } };
  report.host.reach = parts.tried[0];
  report.host.iframe.reach = parts.tried[1];
  report.main.reach = parts.tried[2];
  report.proxy.log = parts.log;
  report.proxy.refused = parts.log.length;
  report.listeners.reachHost = { selfTest: true, hits: parts.hits[0] };
  report.listeners.reachIframe = { selfTest: true, hits: parts.hits[1] };
  report.dns = parts.dns;
  return report;
}

/** A report that passes on an OS with a widget webview and the switch off. */
function passingReport(os = "macos", options = {}) {
  return withReach(baseReport(), os, options);
}

function baseReport() {
  return {
    schema: 5,
    os: "macos",
    policy: {
      widgetWebview: true,
      builtins: "widgets",
      agentWidgets: "off: off until the probe passes",
      agentWidgetsEligibility: "ineligible: WebKit resolves dns-prefetch names outside the deny-all proxy (measured on macOS 26.7), so macOS gets declarative widgets only",
      residual: "dns-prefetch-leak",
    },
    proxy: { support: "deny-all", port: 4321, refused: 3, log: [] },
    dns: null,
    webrtc: "removed (frames.js)",
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
      connections: [{ kind: "rtc", outcome: "no RTCPeerConnection" }],
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
        connections: [{ kind: "rtc", outcome: "no RTCPeerConnection" }],
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
    const checks = evaluate(passingReport("windows"));
    expect(failing(checks)).toEqual([]);
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(true);
  });

  it("keeps macOS ineligible by the policy's residual, even when every gate passes", () => {
    const checks = strictly(() => evaluate(passingReport()));
    expect(failing(checks)).toEqual([]);
    expect(passed(checks)).toBe(true);
    const verdict = agentVerdict(checks);
    expect(verdict).toMatchObject({ mayTurnOn: false, ineligible: true });
    expect(verdict.why).toMatch(/dns-prefetch-leak/);
    expect(toMarkdown("probe", checks)).toContain("Agent-made HTML widgets are **not eligible** on this OS");
  });

  it("refuses a report from another schema", () => {
    const report = passingReport();
    report.schema = 3;
    expect(failing(evaluate(report))).toEqual(["report"]);
  });

  it("fails when the widgets webview isn't behind the deny-all proxy where the OS has one", () => {
    const report = passingReport();
    const row = () => evaluate(report).find((c) => c.id === "widgets webview runs behind the deny-all proxy");
    expect(row().detail).toBe(`127.0.0.1:4321, refused ${report.proxy.refused} connection(s)`);
    report.proxy.port = null;
    expect(row().ok).toBe(false);
    expect(row().detail).toBe("this OS has the proxy, but it isn't running");
    expect(passed(evaluate(report))).toBe(false);
  });

  it("gives a late direct hit to the attempt that could have sent it, not to the next one (macOS CI)", () => {
    // CI, macOS 26.7: localhost's https ClientHellos came 200-242 ms late, the last one inside
    // the slot of sub-localhost's http preconnect, which went to the proxy.
    const report = passingReport();
    const localhost = report.host.iframe.reach.find((a) => a.id === "localhost" && a.scheme === "https");
    const sub = report.host.iframe.reach.find((a) => a.id === "sub-localhost" && a.scheme === "http");
    report.listeners.reachIframe.hits.push(`${sub.at + 2} tcp@::1 tls ClientHello, sni=localhost`);
    const checks = strictly(() => evaluate(report));
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.id.startsWith("widget iframe → localhost")).detail).toBe(
      "http: not in the proxy log; direct: tcp@127.0.0.1 connection, no data · https: not in the proxy log; direct: tcp@127.0.0.1 tls ClientHello, sni=localhost, tcp@::1 tls ClientHello, sni=localhost",
    );
    expect(localhost.at).toBeLessThan(sub.at);
    // A hit that only sub-localhost could have sent still fails its gate.
    const subHttps = report.host.iframe.reach.find((a) => a.id === "sub-localhost" && a.scheme === "https");
    report.listeners.reachIframe.hits.push(`${subHttps.at + 5} tcp@127.0.0.1 tls ClientHello, sni=rlx-widget-iframe.localhost`);
    expect(failing(strictly(() => evaluate(report)))).toEqual(["widget iframe → sub-localhost (rlx-widget-iframe.localhost) reaches only the deny-all proxy"]);
  });

  it("credits an untagged proxy connection to an http preconnect on Windows only", () => {
    // WebKit CONNECTs every proxied preconnect, so on macOS a missing CONNECT fails even with
    // an untagged connection right beside it.
    const report = passingReport();
    const target = report.host.reach.find((a) => a.id === "rfc1918-10" && a.scheme === "http");
    report.proxy.log = report.proxy.log.filter((line) => !line.includes(`CONNECT ${target.authority} `));
    report.proxy.log.push(`${target.at + 5} no data`);
    const row = "host page → rfc1918-10 (10.255.255.1) reaches only the deny-all proxy";
    expect(failing(evaluate(report))).toEqual([row]);
    expect(evaluate(report).find((c) => c.id === row).detail).toMatch(/^http: not in the proxy log/);
  });

  it("reads the proxy's log: CONNECT authorities with or without IPv6 brackets, and untagged connections", () => {
    expect(authorityKey("[fe80::77]:41014")).toBe("fe80::77:41014");
    expect(authorityKey("fe80::77:41014")).toBe("fe80::77:41014");
    expect(authorityKey("Widget-Iframe.rlx-probe-canary.invalid:42028")).toBe("widget-iframe.rlx-probe-canary.invalid:42028");
    const { named, untagged } = readProxyLog([
      "10 CONNECT fe80::77:41014 HTTP/1.1",
      "11 CONNECT [fd00::77]:41023 HTTP/1.1",
      "12 GET http://198.51.100.7/widgets-host/x HTTP/1.1",
      "13 no data",
      "14 3 bytes",
    ]);
    expect([...named.keys()]).toEqual(["fe80::77:41014", "fd00::77:41023", "198.51.100.7:80"]);
    expect(untagged).toEqual([13]);
  });

  it("gates every (side, target) on macOS but the local-network residual, which is info", () => {
    const checks = strictly(() => evaluate(passingReport()));
    expect(failing(checks)).toEqual([]);
    expect(passed(checks)).toBe(true);
    const residual = checks.filter((c) => c.residual).map((c) => c.id);
    expect(residual).toEqual([
      "host page: loopback preconnect (macOS local-network residual (measured))",
      "widget iframe: loopback preconnect (macOS local-network residual (measured))",
      ...["host page", "widget iframe"].flatMap((label) => [
        `${label} → loopback-v4 (127.0.0.1): macOS local-network residual (measured)`,
        `${label} → localhost (localhost): macOS local-network residual (measured)`,
        `${label} → loopback-v6 ([::1]): macOS local-network residual (measured)`,
        `${label} → own-lan-address (${LAN}): macOS local-network residual (measured)`,
        `${label} → link-local-v4 (169.254.77.77): macOS local-network residual (measured)`,
      ]),
    ]);
    expect(checks.find((c) => c.id.startsWith("host page → loopback-v4")).detail).toBe(
      "http: not in the proxy log; direct: tcp@127.0.0.1 connection, no data · https: not in the proxy log; direct: tcp@127.0.0.1 tls ClientHello, no sni",
    );
    // Every other target, on both sides, is a gate that passed: the proxy's log names it.
    const gates = checks.filter((c) => c.gate && c.id.includes(" → "));
    expect(gates).toHaveLength(2 * 8);
    expect(gates.find((c) => c.id === "widget iframe → link-local-v6 ([fe80::77]) reaches only the deny-all proxy").detail).toBe(
      "http: CONNECT [fe80::77]:42014 · https: CONNECT [fe80::77]:42015",
    );
    expect(gates.some((c) => c.id.startsWith("host page → sub-localhost"))).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(false);
  });

  it("fails the gate of an off-host target that goes past the proxy on macOS", () => {
    for (const [id, host, label] of [
      ["ula", "[fd00::77]", "widget iframe"],
      ["lan-peer", "192.168.1.254", "host page"],
      ["link-local-v6", "[fe80::77]", "host page"],
      ["sub-localhost", "rlx-widgets-host.localhost", "host page"],
      ["test-net", "198.51.100.8", "widget iframe"],
    ]) {
      const report = passingReport();
      const side = label === "host page" ? report.host.reach : report.host.iframe.reach;
      const authorities = side.filter((a) => a.id === id).map((a) => authorityKey(a.authority));
      report.proxy.log = report.proxy.log.filter((line) => !authorities.includes(authorityKey(line.split(" ")[2])));
      const checks = evaluate(report);
      const row = `${label} → ${id} (${host}) reaches only the deny-all proxy`;
      expect(failing(checks)).toEqual([row]);
      expect(checks.find((c) => c.id === row).detail).toMatch(/^http: not in the proxy log/);
      expect(passed(checks)).toBe(true);
      expect(agentVerdict(checks).mayTurnOn).toBe(false);
      strictly(() => expect(passed(evaluate(report))).toBe(false));
    }
  });

  it("fails a side that never tried its targets", () => {
    const report = passingReport();
    report.host.iframe.reach = [];
    const failed = failing(evaluate(report));
    expect(failed.filter((id) => id.startsWith("widget iframe → "))).toHaveLength(8);
    expect(evaluate(report).find((c) => c.id.startsWith("widget iframe → test-net")).detail).toBe("http: not attempted · https: not attempted");
    report.reach.plans["widget-iframe"] = [];
    expect(failing(evaluate(report))).toContain("widget iframe: reach plan");
  });

  it("gates every target, loopback included, on Windows, with http matched to untagged proxy connections", () => {
    const report = passingReport("windows");
    report.policy = { widgetWebview: false, builtins: "main", agentWidgets: "off: no widget webview in v0" };
    report.switch.attach = "refused: this OS has no widget webview in v0";
    report.switch.builtinRegister = "refused: this OS has no widget webview in v0";
    report.switch.probeAttach = "attached for the probe only";
    let checks = strictly(() => evaluate(report));
    expect(failing(checks)).toEqual([]);
    expect(checks.some((c) => c.residual)).toBe(false);
    expect(checks.filter((c) => c.gate && c.id.includes(" → "))).toHaveLength(2 * 13);
    expect(checks.find((c) => c.id === "host page → loopback-v4 (127.0.0.1) reaches only the deny-all proxy").detail).toBe(
      "http: a proxy connection at +5 ms (an http preconnect through a proxy sends nothing) · https: CONNECT 127.0.0.1:6000",
    );
    // A direct connection to this host fails both the target and the side.
    report.listeners.reachIframe.hits = [`${report.host.iframe.reach[0].at + 2} tcp@127.0.0.1 connection, no data`];
    checks = evaluate(report);
    expect(failing(checks)).toEqual(["widget iframe → loopback-v4 (127.0.0.1) reaches only the deny-all proxy", "widget iframe: 0 direct connections to this host's own addresses"]);
    strictly(() => expect(passed(evaluate(report))).toBe(false));
    // An http preconnect with no proxy connection near it passes only as "seen by nothing".
    const clean = passingReport("windows");
    const target = clean.host.reach.find((a) => a.id === "rfc1918-10" && a.scheme === "http");
    clean.proxy.log = clean.proxy.log.filter((line) => line !== `${target.at + 5} no data`);
    expect(failing(evaluate(clean))).toEqual([]);
    expect(evaluate(clean).find((c) => c.id.startsWith("host page → rfc1918-10")).detail).toMatch(/^http: seen by nothing/);
  });

  it("on Windows, passes a pair nothing anywhere saw, with the netstat witness's positive control", () => {
    const report = passingReport("windows", { silent: true });
    let checks = strictly(() => evaluate(report));
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.id.startsWith("netstat witness"))).toMatchObject({
      ok: true,
      detail: "200 samples, 3 SYN_SENT endpoint(s); main's: 198.51.100.9:43000, 198.51.100.9:43001",
    });
    expect(checks.find((c) => c.id === "widget iframe → test-net (198.51.100.8) reaches only the deny-all proxy").detail).toBe(
      "http: seen by nothing (no CONNECT, no direct connection or attempt, no lookup) · https: seen by nothing (no CONNECT, no direct connection or attempt, no lookup)",
    );
    // A widget's own connection attempt off this host fails its pair.
    report.netstat.synSent.push("5 [fe80::77]:42015");
    checks = evaluate(report);
    expect(failing(checks)).toEqual(["widget iframe → link-local-v6 ([fe80::77]) reaches only the deny-all proxy"]);
    expect(checks.find((c) => c.id.startsWith("widget iframe → link-local-v6")).detail).toMatch(/https: not in the proxy log; direct: a connection attempt to \[fe80::77\]:42015/);
    strictly(() => expect(passed(evaluate(report))).toBe(false));
    // Without the positive control, "seen by nothing" proves nothing: every silent pair fails.
    const blind = passingReport("windows", { silent: true });
    blind.netstat.synSent = [];
    const failed = failing(evaluate(blind));
    expect(failed[0]).toBe("netstat witness: main's direct connection attempt to its TEST-NET address is seen (positive control)");
    expect(failed.filter((id) => id.endsWith("reaches only the deny-all proxy"))).toHaveLength(2 * 13);
    delete blind.netstat;
    expect(evaluate(blind).find((c) => c.id.startsWith("netstat witness")).detail).toBe("no netstat samples in the report");
    // macOS has no witness: a pair the proxy didn't log fails there.
    expect(evaluate(passingReport()).some((c) => c.id.startsWith("netstat witness"))).toBe(false);
  });

  it("keeps agent-made widgets off where the OS has no per-webview proxy (macOS 13), and fails in strict mode", () => {
    const report = passingReport();
    report.proxy = { support: "unavailable: WebKit has no per-webview proxy before macOS 14", port: null, refused: 0, log: [] };
    const checks = evaluate(report);
    const failed = failing(checks);
    expect(failed[0]).toBe("widgets webview runs behind the deny-all proxy");
    expect(failed.slice(1)).toHaveLength(2 * 8);
    expect(failed.slice(1).every((id) => id.endsWith("reaches only the deny-all proxy"))).toBe(true);
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(false);
    strictly(() => {
      expect(passed(evaluate(report))).toBe(false);
      expect(passed(evaluate(passingReport()))).toBe(true);
    });
  });

  it("records a loopback preconnect at the side's listener as the residual on macOS, and a gate elsewhere", () => {
    const report = passingReport();
    report.listeners.host.hits = ["1 tcp connection, no data", "2 tcp connection, no data"];
    report.listeners.iframe.hits = ["1 tcp connection, no data"];
    let checks = evaluate(report);
    const row = checks.find((c) => c.id === "host page: loopback preconnect (macOS local-network residual (measured))");
    expect(row.info).toBe(true);
    expect(row.detail).toMatch(/^2 TCP connection\(s\) that sent nothing: preconnect ×2\. macOS never proxies loopback/);
    expect(failing(checks)).toEqual([]);
    for (const os of ["windows", "linux"]) {
      const other = passingReport(os);
      other.listeners.iframe.hits = ["1 tcp connection, no data"];
      checks = evaluate(other);
      expect(failing(checks)).toContain("widget iframe: 0 preconnect connections");
      expect(checks.some((c) => c.residual)).toBe(false);
      strictly(() => expect(passed(evaluate(other))).toBe(false));
    }
  });

  it("fails when main's off-machine preconnect reaches the widgets' proxy (main behind it)", () => {
    const report = passingReport();
    const id = "main's networking unchanged: its off-machine preconnects never reach the widgets' proxy";
    expect(evaluate(report).find((c) => c.id === id)).toMatchObject({
      ok: true,
      detail: "main tried http://198.51.100.9:43000, https://198.51.100.9:43001; 0 in the proxy log",
    });
    // The realistic regression: the proxy lands on main's data store too.
    report.proxy.log.push("1 CONNECT 198.51.100.9:43001 HTTP/1.1");
    expect(failing(evaluate(report))).toEqual([id]);
    expect(evaluate(report).find((c) => c.id === id).detail).toBe(
      "main tried http://198.51.100.9:43000, https://198.51.100.9:43001; in the proxy log: 198.51.100.9:43001",
    );
    expect(passed(evaluate(report))).toBe(false);
    // Main that never tried proves nothing.
    const idle = passingReport();
    idle.main.reach = [];
    expect(failing(evaluate(idle))).toEqual([id]);
  });

  it("fails when main's preconnect doesn't reach the control listener (the positive control)", () => {
    const report = passingReport();
    const id = "main's preconnect works (positive control: it reaches the control listener)";
    expect(evaluate(report).find((c) => c.id === id).detail).toBe("1 preconnect connection(s); main added");
    report.listeners.control.hits = ["1 udp 20 bytes (STUN/TURN)"];
    expect(failing(evaluate(report))).toContain(id);
    expect(passed(evaluate(report))).toBe(false);
  });

  it("measures DNS where CI routes the probe's zone: main's names are the control, widgets' names get 0 queries", () => {
    const unmeasured = evaluate(passingReport());
    expect(unmeasured.find((c) => c.id === "DNS: widgets' names looked up")).toMatchObject({ info: true });

    const report = passingReport("macos", { dns: true });
    let checks = strictly(() => evaluate(report));
    expect(failing(checks)).toEqual([]);
    const control = "DNS: the probe's zone reaches its listener (positive control: main's names are looked up there)";
    expect(checks.find((c) => c.id === control).detail).toBe(
      "1 DNS query for main.rlx-probe-dns.test; main's dns-prefetch name: 1 DNS query; 2 DNS queries in all",
    );
    expect(checks.find((c) => c.id === "widget iframe → dns-prefetch (widget-iframe-prefetch.rlx-probe-dns.test): no lookup outside the proxy").detail).toBe(
      "dns-prefetch: 0 DNS queries",
    );
    expect(checks.find((c) => c.id === "host page → dns-name (widgets-host.rlx-probe-dns.test) reaches only the deny-all proxy").detail).toBe(
      "http: CONNECT widgets-host.rlx-probe-dns.test:41026; 0 DNS queries · https: CONNECT widgets-host.rlx-probe-dns.test:41027; 0 DNS queries",
    );
    // macOS: a widget's dns-prefetch name looked up is the known reason macOS isn't eligible.
    // It stays a gate (⛔), but a strict run fails only on other gates.
    report.dns.queries.push("1 AAAA widget-iframe-prefetch.rlx-probe-dns.test", "1 A widget-iframe-prefetch.rlx-probe-dns.test");
    checks = strictly(() => evaluate(report));
    const prefetch = "widget iframe → dns-prefetch (widget-iframe-prefetch.rlx-probe-dns.test): no lookup outside the proxy";
    expect(failing(checks)).toEqual([prefetch]);
    expect(checks.find((c) => c.id === prefetch)).toMatchObject({ gate: true, blocking: false });
    expect(checks.find((c) => c.id === prefetch).detail).toBe(
      "dns-prefetch: 2 DNS queries (the known reason macOS isn't eligible: WebKit resolves dns-prefetch names outside the proxy)",
    );
    expect(passed(checks)).toBe(true);
    expect(agentVerdict(checks).mayTurnOn).toBe(false);
    expect(toMarkdown("probe", checks)).toContain(`| ⛔ | ${prefetch} |`);
    // Any other DNS leak on macOS fails a strict run.
    report.dns.queries.push("2 A widgets-host.rlx-probe-dns.test");
    checks = strictly(() => evaluate(report));
    expect(failing(checks)).toContain("host page → dns-name (widgets-host.rlx-probe-dns.test) reaches only the deny-all proxy");
    expect(passed(checks)).toBe(false);
    // On Windows a dns-prefetch lookup is an ordinary gate: strict fails.
    const windows = passingReport("windows", { dns: true });
    windows.dns.queries.push("1 A widgets-host-prefetch.rlx-probe-dns.test");
    strictly(() => expect(passed(evaluate(windows))).toBe(false));
    // The exemption comes from the policy's recorded residual, not the OS: a macOS report
    // without it fails strict on the same lookup.
    const unrecorded = passingReport("macos", { dns: true });
    unrecorded.policy.residual = null;
    unrecorded.dns.queries.push("1 A widget-iframe-prefetch.rlx-probe-dns.test");
    checks = strictly(() => evaluate(unrecorded));
    expect(checks.find((c) => c.id === prefetch)).toMatchObject({ ok: false, blocking: true });
    expect(passed(checks)).toBe(false);
    // No query for main's name: the route doesn't work, and the run fails.
    const noRoute = passingReport("windows", { dns: true });
    noRoute.dns.queries = [];
    expect(failing(evaluate(noRoute))).toEqual([control]);
    expect(passed(evaluate(noRoute))).toBe(false);
    noRoute.dns = { zone: "rlx-probe-dns.test", error: "127.0.0.1:53: address in use" };
    expect(failing(evaluate(noRoute))).toContain(control);
  });

  it("checks that WebRTC ran in both frames in the WebRTC-kept run", () => {
    const report = passingReport("windows");
    report.webrtc = "kept for the probe (RLXAPP_E2E_RTC=kept)";
    const id = "WebRTC kept for the probe: it ran in both frames (positive control)";
    expect(failing(evaluate(report))).toEqual([id]);
    report.host.connections = [{ kind: "rtc", outcome: "gathering complete" }];
    report.host.iframe.connections = [{ kind: "rtc", outcome: "gathering complete" }];
    expect(failing(evaluate(report))).toEqual([]);
    // Its STUN reaching the listener is recorded (frames.js is WebRTC's barrier); every other
    // channel stays gated, strictly.
    report.listeners.iframe.hits = ["1 udp 20 bytes (STUN/TURN)", "2 udp 28 bytes (STUN/TURN)"];
    let checks = strictly(() => evaluate(report));
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.id === "widget iframe: WebRTC with frames.js skipped (recorded)")).toMatchObject({
      info: true,
      detail: "rtc ×2: WebRTC's UDP gets past the proxy, so frames.js is its only barrier",
    });
    report.listeners.iframe.hits.push("3 tcp GET /widget-iframe/fetch HTTP/1.1");
    checks = strictly(() => evaluate(report));
    expect(failing(checks)[0]).toMatch(/^widget iframe: 0 connections/);
    expect(passed(checks)).toBe(false);
    // Outside that run, a WebRTC hit is a channel like any other.
    const normal = passingReport("windows");
    normal.listeners.iframe.hits = ["1 udp 20 bytes (STUN/TURN)"];
    expect(failing(evaluate(normal))[0]).toMatch(/^widget iframe: 0 connections/);
    expect(evaluate(passingReport()).some((c) => c.id === id)).toBe(false);
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
    const report = passingReport("windows");
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
    expect(evaluate(report).find((c) => c.id.startsWith("main's preconnect works")).info).toBe(true);
    expect(evaluate(report).some((c) => c.id.startsWith("main's networking unchanged"))).toBe(false);
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
