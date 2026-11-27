// The isolation probe's rules (docs/architecture.md §5.3): one rule for every channel on
// every OS. `evaluate` turns the report the test build writes (src-tauri/src/e2e/) into
// checks. Any failed check fails the run.
//
// What the rules never assert: that a raw channel (__TAURI_INTERNALS__, chrome.webview,
// webkit.messageHandlers, the ipc:// fetch) is absent. Channels may exist and may deliver.
// What must hold is that nothing they carry runs: every command is rejected (by the missing
// key or the ACL), and the canary records no call from a widget.

/** The fixture's navigation step's request paths: any hit is a frame leaving the scheme. */
const FRAME_NAVIGATION = new Set(["navigate", "ping-target", "meta-refresh", "top-navigation", "window-open", "form"]);

/**
 * Reach targets (src-tauri/src/e2e/reach.rs) that go past the deny-all proxy on macOS 14+:
 * this Mac (loopback, `localhost`, its own LAN address) and link-local IPv4. The owner
 * accepted them, with a warning in the "Custom HTML widgets" opt-in
 * (src-tauri/src/widget_host/proxy.rs). Every other target is a gate on macOS too.
 */
const MACOS_RESIDUAL = new Set(["loopback-v4", "localhost", "loopback-v6", "own-lan-address", "link-local-v4"]);
const RESIDUAL = "owner-accepted macOS residual (warned)";

/** The probe's sides that sit behind the proxy, as reach.rs names them, with their labels. */
const SIDES = [
  ["widgets-host", "host page"],
  ["widget-iframe", "widget iframe"],
];

/** Tauri's message when it drops an IPC message with the wrong key (tauri webview/mod.rs). */
const KEY_DROP = /__TAURI_INVOKE_KEY__ expected (\S+) but received (\S+)/;

/** Replaces the app's real invoke key in a stderr line, so logs never carry it. */
export function redactKey(line) {
  return line.replace(KEY_DROP, (_, _expected, received) => `__TAURI_INVOKE_KEY__ expected <redacted> but received ${received}`);
}

/** The probe's raw messages (key `rlx-probe-<from>-<channel>`) that reached Tauri and were dropped. */
export function droppedRawMessages(stderr) {
  const dropped = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = KEY_DROP.exec(line);
    if (match && match[2].startsWith("rlx-probe-")) dropped.push(match[2].slice("rlx-probe-".length));
  }
  return dropped;
}

const ACL_REJECTION = /not allowed/i;

/**
 * @param {any} report the parsed JSON report
 * @param {{ stderr?: string }} [extra]
 * @returns {{ id: string, ok: boolean, detail: string, info?: boolean }[]}
 */
export function evaluate(report, { stderr = "" } = {}) {
  const checks = evaluateChecks(report, stderr);
  const agentOn = String(report?.policy?.agentWidgets ?? "") === "on";
  const strict = process.env.RLX_PROBE_STRICT === "1";
  for (const c of checks) {
    if (c.gate && !c.ok) c.blocking = agentOn || strict;
    else if (!c.ok) c.blocking = true;
  }
  return checks;
}

/** Whether agent-made widgets may be turned on for the OS the report came from. */
export function agentVerdict(checks) {
  if (checks.some((c) => c.noWebview)) {
    return { mayTurnOn: false, why: "this OS has no widget webview in v0", noWebview: true };
  }
  const failing = checks.filter((c) => !c.ok);
  return failing.length === 0
    ? { mayTurnOn: true, why: "every check passed" }
    : { mayTurnOn: false, why: failing.map((c) => c.id).join("; ") };
}

/** True when nothing blocking failed. */
export function passed(checks) {
  return checks.every((c) => c.ok || !c.blocking);
}

function evaluateChecks(report, stderr) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const info = (id, detail) => checks.push({ id, ok: true, info: true, detail });
  // A gate check decides whether agent-made widgets may be turned on for this OS. It fails the
  // run when the switch is on (or in strict mode). With the switch off, a failure is recorded
  // as "must stay off" and the run continues.
  const gate = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), gate: true, detail });

  if (!report || report.schema !== 5) {
    check("report", false, "no report, or an unknown schema");
    return checks;
  }

  const policy = report.policy ?? {};
  // Where the product has no widget webview (Windows in v0), the probe may attach one anyway
  // to measure the webview; its checks then run the same way.
  const probed = policy.widgetWebview === true || String(report.switch?.probeAttach ?? "").startsWith("attached");
  const agentOff = String(policy.agentWidgets ?? "").startsWith("off");
  const listeners = report.listeners ?? {};
  const canary = report.canary ?? [];
  const main = report.main ?? {};

  check("probe errors", (report.errors ?? []).length === 0, (report.errors ?? []).join("; ") || "none");
  const selfTests = ["host", "iframe", "control"].map((name) => `${name} ${listeners[name]?.selfTest}`);
  check(
    "listener self-tests",
    ["host", "iframe", "control"].every((name) => listeners[name]?.selfTest === true),
    selfTests.join(", "),
  );

  // The canary: main's control call must be recorded, and nothing else.
  const control = canary.filter((call) => call.from === "main-control" && call.webview === "main");
  check(
    "canary positive control (main)",
    control.length >= 1 && main.canary?.result === "resolved",
    `${control.length} recorded; main saw ${main.canary?.result ?? "nothing"}`,
  );
  const stray = canary.filter((call) => !(call.from === "main-control" && call.webview === "main"));
  if (!probed && stray.length === 0) {
    // No widget code ran on this OS, so "0 calls" would prove nothing. Any stray call would
    // still fail below.
    info("canary: 0 calls from widgets", "n/a: no widget surface on this OS");
  } else {
    check(
      "canary: 0 calls from widgets",
      stray.length === 0,
      stray.length === 0 ? "0 calls" : stray.map((c) => `${c.from} via ${c.webview}`).join(", "),
    );
  }

  // Connections. Each side has its own listener; a hit is classified by what it carried.
  for (const side of ["host", "iframe"]) {
    if (!probed) break;
    const hits = (listeners[side]?.hits ?? []).map(classifyHit);
    const contract = hits.filter((h) => h.vector !== "preconnect");
    const silent = hits.filter((h) => h.vector === "preconnect");
    const label = side === "host" ? "host page" : "widget iframe";
    // On a webview only the probe attached (the product attaches none on this OS), a leak
    // can't reach a user: it keeps the widget webview and agent-made widgets off here.
    (policy.widgetWebview ? check : gate)(
      `${label}: 0 connections (fetch, XHR, WebSocket, EventSource, beacon, keepalive fetch, pagehide beacon, img, CSS, fonts, SVG, prefetch, preload, ping, WebRTC, navigation, refresh)`,
      contract.length === 0,
      (contract.length === 0 ? "0 connections, 0 datagrams" : summarizeHits(contract)) +
        (policy.widgetWebview ? "" : " (probe-only webview: the product attaches none on this OS)"),
    );
    const silentDetail = silent.length === 0 ? "0 connections" : `${silent.length} TCP connection(s) that sent nothing: ${summarizeHits(silent)}`;
    if (report.os === "macos") {
      // The owner-accepted macOS residual: Network.framework never proxies loopback, so a
      // preconnect can still open a connection to a port on this Mac. The reach rows below
      // gate every other destination there.
      checks.push({
        id: `${label}: loopback preconnect (${RESIDUAL})`,
        ok: true,
        info: true,
        residual: true,
        detail: `${silentDetail}. macOS never proxies loopback (src-tauri/src/widget_host/proxy.rs)`,
      });
    } else {
      gate(`${label}: 0 preconnect connections`, silent.length === 0, silentDetail);
    }
  }
  // The deny-all proxy (src-tauri/src/widget_host/proxy.rs). Where this OS has a per-webview
  // proxy, a widgets webview without it is a bug. Where it has none (macOS 11-13), agent-made
  // widgets must stay off there.
  if (probed) {
    const proxy = report.proxy ?? {};
    const support = String(proxy.support ?? "not reported");
    const behind = support === "deny-all" && Number.isInteger(proxy.port);
    (support === "deny-all" ? check : gate)(
      "widgets webview runs behind the deny-all proxy",
      behind,
      behind
        ? `127.0.0.1:${proxy.port}, refused ${proxy.refused ?? 0} connection(s)`
        : support === "deny-all"
          ? "this OS has the proxy, but it isn't running"
          : support,
    );
    reachChecks(report, checks, { check, gate, info });
  }
  // Frame navigation off the widget scheme is held by the host CSP's frame-src, and on
  // Windows by nothing else (wry asks the guard about top-level navigations only). So a hit
  // from the fixture's navigation step fails the run on every OS, whatever the policy: a
  // frame-src regression must turn CI red.
  if (probed) {
    const frameNavigation = (listeners.iframe?.hits ?? []).map(classifyHit).filter((h) => FRAME_NAVIGATION.has(h.vector));
    check(
      "widget frame can't navigate off the widget scheme (navigate, link, meta refresh, top, popup, form)",
      frameNavigation.length === 0,
      frameNavigation.length === 0 ? "0 requests" : summarizeHits(frameNavigation),
    );
  }
  const controlHits = listeners.control?.hits ?? [];
  info("listener control (main WebRTC)", `${main.rtc ?? "not run"}; control listener saw ${controlHits.length}`);
  // Positive control for main's rows: main's preconnect works at all (CSP doesn't govern
  // it), so it reaches the control listener. Loopback can't show main is off the proxy on
  // macOS, which never proxies loopback; main's off-machine row (reachChecks) does.
  const mainPreconnects = controlHits.map(classifyHit).filter((h) => h.vector === "preconnect").length;
  const mainControl = "main's preconnect works (positive control: it reaches the control listener)";
  const mainDetail = `${mainPreconnects} preconnect connection(s); main ${main.preconnect ?? "added none"}`;
  if (probed) check(mainControl, mainPreconnects >= 1, mainDetail);
  else info(mainControl, `${mainDetail} (no widgets webview, so no proxy here)`);
  check("main CSP blocks frames", String(main.frameSrc ?? "").startsWith("blocked"), String(main.frameSrc));

  // The per-OS switch, through the product API.
  const agentRegister = String(report.switch?.agentRegister ?? "");
  check(
    "agent-made widgets switch honoured",
    agentOff ? agentRegister.startsWith("refused") : agentRegister.startsWith("registered"),
    `switch ${policy.agentWidgets}; register → ${agentRegister}`,
  );

  const builtinRegister = String(report.switch?.builtinRegister ?? "");
  check(
    `built-ins register only where they render in the widget webview (${policy.builtins})`,
    policy.builtins === "widgets" ? builtinRegister.startsWith("registered") : builtinRegister.startsWith("refused"),
    builtinRegister,
  );
  check(
    "main can't reach the action route",
    !String(main.actionRoute ?? "").startsWith("response 2"),
    String(main.actionRoute),
  );

  const webviews = report.webviews ?? [];
  if (!policy.widgetWebview) {
    // Windows and Linux in v0: built-ins render in main, and the product attaches no widget
    // webview. Only the probe's own attach (Windows) may add one.
    check("the product attaches no widget webview here", String(report.switch?.attach).startsWith("refused"), String(report.switch?.attach));
    const expected = probed ? ["main", "widgets"] : ["main"];
    check(
      "no other webviews",
      JSON.stringify(webviews) === JSON.stringify(expected),
      `webviews: ${webviews.join(", ")}${probed ? " (widgets attached for the probe only)" : ""}`,
    );
    if (!probed) {
      checks.push({ id: "no widget webview on this OS", ok: true, info: true, noWebview: true, detail: "nothing here to turn on" });
      return checks;
    }
  } else {
    check(
      "widgets webview attached",
      report.switch?.attach === "attached" && webviews.includes("widgets") && webviews.includes("main"),
      `${report.switch?.attach}; webviews: ${webviews.join(", ")}`,
    );
  }

  const mount = report.mount ?? {};
  const mountedIds = mount.ids ?? [];
  check(
    "widgets_mount resolves once the host page has mounted",
    mount.ok === true && mountedIds.includes("e2e-probe") && mountedIds.includes("e2e-builtin") && !mountedIds.includes("e2e-agent"),
    mount.ok ? `mounted: ${mountedIds.join(", ")}` : String(mount.error),
  );
  const reload = report.reload ?? {};
  const restored = reload.frames ?? [];
  check(
    "a reload of the widgets webview restores the grid",
    reload.loadsAfter > reload.loadsBefore && JSON.stringify([...restored].sort()) === JSON.stringify([...mountedIds].sort()),
    `page loads ${reload.loadsBefore} → ${reload.loadsAfter}; frames after: ${restored.join(", ") || "none"}`,
  );

  const host = report.host;
  if (!host || typeof host !== "object") {
    check("host page probe", false, "the host page never reported");
    return checks;
  }
  check("host page probe", host.done === true && (host.errors ?? []).length === 0, (host.errors ?? []).join("; ") || "ran");
  info("host page channels", describeChannels(host.channels));

  const hostCommands = host.commands ?? [];
  const hostNotRejected = hostCommands.filter((c) => !(c.result === "rejected" && ACL_REJECTION.test(c.message)));
  check(
    "host page: every command rejected",
    hostCommands.length > 0 && hostCommands.length === report.commandCount && hostNotRejected.length === 0,
    hostNotRejected.length === 0
      ? `${hostCommands.length}/${report.commandCount} rejected (${sample(hostCommands)})`
      : hostNotRejected.slice(0, 8).map((c) => `${c.cmd}: ${c.result} ${c.message}`).join("; "),
  );
  info("host page: channel fetch (exempt)", host.channelFetch ? `${host.channelFetch.result}: ${host.channelFetch.message}` : "not called");
  info("host page: raw channels", (host.raw ?? []).map((r) => `${r.channel} ${r.outcome}`).join("; "));
  info("host page: connection attempts", (host.connections ?? []).map((c) => `${c.kind} ${c.outcome}`).join("; "));

  const frame = host.iframe;
  if (!frame || typeof frame !== "object") {
    check("widget iframe probe", false, "the widget iframe never reported");
  } else {
    check("widget iframe probe", (frame.errors ?? []).length === 0, (frame.errors ?? []).join("; ") || "ran");
    check("widget iframe got init and a port", frame.initReceived === true, String(frame.initReceived));
    const sandbox = frame.sandbox ?? {};
    const leaks = Object.entries(sandbox).filter(([, outcome]) => !String(outcome).startsWith("blocked"));
    check(
      "widget iframe: opaque origin, no host DOM or storage",
      frame.origin === "null" && leaks.length === 0 && Object.keys(sandbox).length > 0,
      `origin ${frame.origin}; ${leaks.length === 0 ? "all blocked" : leaks.map(([k, v]) => `${k} ${v}`).join("; ")}`,
    );
    info("widget iframe channels", describeChannels(frame.channels));
    // Say what the evidence shows. From the iframe, a call can be rejected by the ACL (the
    // reply reaches the iframe) or go unanswered (the reply, if any, goes to the host
    // frame). Neither ran a command; the canary is the proof that nothing did.
    const frameCommands = frame.commands ?? [];
    const ran = frameCommands.filter((c) => c.result === "resolved" || (c.result === "rejected" && !ACL_REJECTION.test(c.message)));
    const rejected = frameCommands.filter((c) => c.result === "rejected" && ACL_REJECTION.test(c.message)).length;
    const unanswered = frameCommands.filter((c) => c.result === "timeout" || c.result === "threw").length;
    const ownCanary = frameCommands.some((c) => c.cmd === "e2e_canary");
    const canaryNote = stray.length === 0 ? `canary 0${ownCanary ? ", including the iframe's own canary call" : ""}` : `canary ${stray.length}`;
    const parts = [rejected > 0 ? `${rejected} rejected by the ACL` : "", unanswered > 0 ? `${unanswered} unanswered` : ""].filter(Boolean);
    check(
      "widget iframe: no command ran",
      ran.length === 0 && stray.length === 0,
      frameCommands.length === 0
        ? `no invoke() in the iframe; raw channels only (${canaryNote})`
        : ran.length === 0
          ? `${parts.join(", ")}; ${canaryNote}`
          : ran.slice(0, 8).map((c) => `${c.cmd}: ${c.result} ${c.message}`).join("; "),
    );
    const sibling = frame.siblingInit ?? {};
    check(
      "a sibling frame can't init another widget",
      Array.isArray(sibling.answered) && sibling.answered.length === 0,
      `${sibling.siblings ?? "?"} sibling(s) sent a fake init; answered: ${(sibling.answered ?? []).join(", ") || "none"}`,
    );
    info("widget iframe: raw channels", (frame.raw ?? []).map((r) => `${r.channel} ${r.outcome}`).join("; "));
    info("widget iframe: connection attempts", (frame.connections ?? []).map((c) => `${c.kind} ${c.outcome}`).join("; "));
  }

  // The WebRTC-kept run (RLXAPP_E2E_RTC=kept): frames.js is skipped, so the connection rows
  // above show what the network setup alone does with WebRTC. It must have run in both
  // frames, or "0 connections" proves nothing.
  if (String(report.webrtc ?? "").startsWith("kept")) {
    const rtcRun = (list) => (list ?? []).find((c) => c.kind === "rtc")?.outcome ?? "not run";
    const runs = [rtcRun(host.connections), rtcRun(host.iframe?.connections)];
    check(
      "WebRTC kept for the probe: it ran in both frames (positive control)",
      runs.every((outcome) => String(outcome).startsWith("gathering")),
      `host page: ${runs[0]}; widget iframe: ${runs[1]}`,
    );
  }

  const navigations = report.navigations ?? [];
  info(
    "navigations the guard was asked about",
    navigations.length === 0 ? "none" : navigations.map((n) => `${n.allowed ? "allowed" : "denied"} ${n.url}`).join("; "),
  );

  const dropped = droppedRawMessages(stderr);
  info("raw messages Tauri dropped for the key", dropped.length === 0 ? "none reached Tauri" : dropped.join(", "));

  const ran = (host.ran ?? []).map((r) => r.id);
  check("built-in control widget ran", ran.includes("e2e-builtin"), `ran: ${ran.join(", ") || "none"}`);
  check(
    agentOff ? "refused agent-made widget never ran" : "agent-made widget ran (switch on)",
    agentOff ? !ran.includes("e2e-agent") : ran.includes("e2e-agent"),
    `ran: ${ran.join(", ") || "none"}`,
  );
  const actions = report.actions ?? [];
  const builtinAction = actions.some((a) => a.widgetId === "e2e-builtin" && a.message?.type === "refresh");
  const strayActions = actions.filter((a) => a.widgetId !== "e2e-builtin");
  check(
    "action route: the built-in's SDK action arrived, and nothing else",
    builtinAction && strayActions.length === 0,
    `${actions.length} accepted: ${actions.map((a) => `${a.widgetId} ${a.message?.type}`).join(", ") || "none"}`,
  );
  const tokenless = (host.raw ?? []).find((r) => r.channel === "action-route (no token)");
  check(
    "action route refuses a request without the host token",
    String(tokenless?.outcome).startsWith("response 403"),
    String(tokenless?.outcome),
  );
  const frameRoute = (host.iframe?.raw ?? []).find((r) => r.channel === "action-route");
  check(
    "action route unreachable from a widget frame",
    frameRoute !== undefined && !String(frameRoute.outcome).startsWith("response 2"),
    String(frameRoute?.outcome),
  );

  const frames = host.frames ?? [];
  check(
    "every widget frame is sandbox=allow-scripts",
    frames.length > 0 && frames.every((f) => f.sandbox === "allow-scripts"),
    frames.map((f) => `${f.id}: ${f.sandbox}`).join("; "),
  );

  const after = report.hostAfterNavigation;
  // Positive control: the fixture's navigation step must have run, or "0 requests" proves
  // nothing.
  const navigation = after?.navigation ?? null;
  check(
    "the fixture's navigation step ran (positive control)",
    Array.isArray(navigation?.ack),
    Array.isArray(navigation?.ack) ? `ack for ${navigation.ack.length} navigation(s)` : "no ack from the fixture",
  );
  info(
    "CSP violations the host page saw during navigation",
    (navigation?.violations ?? []).join("; ") || "none reported",
  );
  (policy.widgetWebview ? check : gate)(
    "host page stays on the widget scheme after navigating",
    after && typeof after.href === "string" && after.href === host.href && after.frames === report.framesBeforeNavigation,
    after
      ? `host still at ${after.href}, ${after.frames} frames (whether a request still went out is the host page's connection check)`
      : "host page gone after navigating",
  );
  return checks;
}

/**
 * A listener hit, `"<ms> <what>"`, as { at, what, vector }. HTTP requests carry the probe's
 * path tag (/<side>/<vector>); STUN/TURN is WebRTC; a TCP connection that sent nothing is a
 * preconnect or dns-prefetch (WebRTC is ruled out by its own STUN bytes).
 */
export function classifyHit(hit) {
  const [at, ...rest] = String(hit).split(" ");
  const what = rest.join(" ");
  let vector = "other";
  const path = /^tcp \w+ \/[\w.-]+\/([\w.-]+)/.exec(what);
  if (path) vector = path[1];
  else if (what.includes("(STUN/TURN)")) vector = "rtc";
  else if (what === "tcp connection, no data") vector = "preconnect";
  return { at: Number(at), what, vector };
}

/**
 * `host:port`, lowercase, with IPv6 brackets dropped: Network.framework writes
 * `CONNECT fe80::77:41014`, Chromium `CONNECT [fe80::77]:41014`.
 */
export function authorityKey(authority) {
  const text = String(authority).trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  return bracketed ? `${bracketed[1]}:${bracketed[2]}` : text;
}

/**
 * The deny-all proxy's test-build log (`"<ms> <first line>"`, src-tauri/src/widget_host/proxy.rs):
 * the authorities it was asked for (a CONNECT, or an absolute-form request), and the times of
 * its untagged connections, which sent nothing (Chromium's preconnect of an http URL through
 * a proxy opens a connection to the proxy and sends nothing).
 */
export function readProxyLog(log = []) {
  const named = new Map();
  const untagged = [];
  for (const line of log) {
    const [atText, ...rest] = String(line).split(" ");
    const at = Number(atText);
    const what = rest.join(" ");
    const connect = /^CONNECT (\S+) HTTP\//.exec(what);
    const absolute = /^[A-Z]+ (https?):\/\/([^/\s]+)\S* HTTP\//.exec(what);
    let key = null;
    if (connect) key = authorityKey(connect[1]);
    else if (absolute) key = authorityKey(/:\d+$/.test(absolute[2]) ? absolute[2] : `${absolute[2]}:${absolute[1] === "https" ? 443 : 80}`);
    if (key) named.set(key, [...(named.get(key) ?? []), at]);
    else if (what === "no data") untagged.push(at);
  }
  return { named, untagged };
}

/** A reach listener's hit, `"<ms> tcp@<address> <what>"`, as { at, address, what }. */
function readReachHit(hit) {
  const match = /^(\d+) tcp@(\S+) (.*)$/.exec(String(hit));
  return match ? { at: Number(match[1]), address: match[2], what: match[3] } : { at: NaN, address: "?", what: String(hit) };
}

/** The DNS listener's queries, `"<ms> <type> <name>"` (src-tauri/src/e2e/dns.rs). */
function readQueries(dns) {
  return (dns?.queries ?? []).map((line) => {
    const [at, type, name] = String(line).split(" ");
    return { at: Number(at), type, name: String(name ?? "").toLowerCase() };
  });
}

function dnsQueries(n) {
  return `${n} DNS quer${n === 1 ? "y" : "ies"}`;
}

/**
 * The reach rows (src-tauri/src/e2e/reach.rs): one per (side, target), each over http and
 * https. A target reaches only the proxy when the proxy's log names its authority (or, for an
 * http preconnect through Chromium's proxy, an untagged proxy connection lines up with it in
 * time) and nothing past the proxy saw it: the side's reach listener, for this host's own
 * addresses, and the DNS listener, for the probe's zone. On macOS the owner-accepted residual
 * is recorded as info; every other pair is a gate. Main's own targets must never reach the
 * proxy, and its zone name is the DNS route's positive control.
 */
function reachChecks(report, checks, { check, gate, info }) {
  const macos = report.os === "macos";
  const plans = report.reach?.plans ?? {};
  const listeners = report.listeners ?? {};
  const proxyLog = readProxyLog(report.proxy?.log ?? []);
  const queries = readQueries(report.dns);
  const dnsMeasured = Boolean(report.dns && !report.dns.error);
  const tried = {
    "widgets-host": report.host?.reach ?? [],
    "widget-iframe": report.host?.iframe?.reach ?? [],
    main: report.main?.reach ?? [],
  };
  const reachHits = {
    "widgets-host": (listeners.reachHost?.hits ?? []).map(readReachHit),
    "widget-iframe": (listeners.reachIframe?.hits ?? []).map(readReachHit),
  };
  const residual = (id) => macos && MACOS_RESIDUAL.has(id);

  // Untagged proxy connections go, in time order, to the http preconnects no log line names:
  // first each to the one whose slot (until the next attempt, 250 ms on) it falls in, then
  // any left over to one up to 2 s before it. The sides run one after the other.
  const free = [...proxyLog.untagged].sort((a, b) => a - b);
  const evidence = new Map();
  const widgetAttempts = SIDES.flatMap(([side]) => tried[side].map((attempt) => ({ side, attempt }))).sort((a, b) => a.attempt.at - b.attempt.at);
  const unnamed = [];
  widgetAttempts.forEach(({ side, attempt }, index) => {
    const named = attempt.rel === "preconnect" && proxyLog.named.has(authorityKey(attempt.authority));
    const next = widgetAttempts[index + 1]?.attempt.at ?? attempt.at + 250;
    const direct = attempt.class === "on-host" ? reachHits[side].filter((h) => h.at >= attempt.at - 20 && h.at < next - 20) : [];
    const looked = queries.filter((q) => q.name === String(attempt.host).toLowerCase());
    const found = { named, untagged: null, direct, looked };
    evidence.set(attempt, found);
    if (!named && attempt.rel === "preconnect" && attempt.scheme === "http" && !residual(attempt.id)) unnamed.push({ attempt, found, until: next - 20 });
  });
  for (const pass of ["slot", "late"]) {
    for (const { attempt, found, until } of unnamed) {
      if (found.untagged !== null) continue;
      const end = pass === "slot" ? until : attempt.at + 2000;
      const index = free.findIndex((at) => at >= attempt.at - 20 && at < end);
      if (index >= 0) found.untagged = free.splice(index, 1)[0];
    }
  }

  for (const [side, label] of SIDES) {
    const plan = plans[side] ?? [];
    const ids = [...new Set(plan.map((a) => a.id))];
    if (ids.length === 0) {
      check(`${label}: reach plan`, false, "the report has no reach plan for this side");
      continue;
    }
    for (const id of ids) {
      const planned = plan.filter((a) => a.id === id);
      const host = planned[0].host;
      const parts = [];
      let ok = true;
      for (const target of planned) {
        const attempt = tried[side].find((a) => a.id === target.id && a.scheme === target.scheme && a.rel === target.rel);
        const name = target.rel === "dns-prefetch" ? "dns-prefetch" : target.scheme;
        if (!attempt) {
          ok = false;
          parts.push(`${name}: not attempted`);
          continue;
        }
        const { named, untagged, direct, looked } = evidence.get(attempt);
        const seen = [];
        if (target.rel === "preconnect") {
          if (named) seen.push(`CONNECT ${target.authority}`);
          else if (untagged !== null) seen.push(`a proxy connection at +${untagged - attempt.at} ms (an http preconnect through a proxy sends nothing)`);
          else {
            ok = false;
            seen.push(direct.length > 0 || residual(id) ? "not in the proxy log" : "not in the proxy log (went past it, or never left)");
          }
        }
        if (direct.length > 0) {
          ok = false;
          const counts = {};
          for (const h of direct) counts[`tcp@${h.address} ${h.what}`] = (counts[`tcp@${h.address} ${h.what}`] ?? 0) + 1;
          seen.push(`direct: ${Object.entries(counts).map(([what, n]) => (n > 1 ? `${n}× ${what}` : what)).join(", ")}`);
        }
        if (dnsMeasured && String(host).endsWith(report.dns.zone)) {
          if (looked.length > 0) ok = false;
          seen.push(dnsQueries(looked.length));
        }
        parts.push(`${name}: ${seen.join("; ")}`);
      }
      const rowId = `${label} → ${id} (${host})`;
      const detail = parts.join(" · ");
      if (residual(id)) {
        checks.push({ id: `${rowId}: ${RESIDUAL}`, ok: true, info: true, residual: true, detail });
      } else {
        gate(`${rowId} reaches only the deny-all proxy`, ok, detail);
      }
    }
    // Off macOS, nothing reaches this host directly at all (WebView2 proxies loopback too).
    if (!macos) {
      const hits = reachHits[side];
      gate(`${label}: 0 direct connections to this host's own addresses`, hits.length === 0, hits.length === 0 ? "0 connections" : hits.map((h) => `tcp@${h.address} ${h.what}`).slice(0, 8).join("; "));
    }
  }

  // Main isn't behind the widgets webview's proxy: none of its off-machine preconnects may
  // reach it. This is the row that fails if the proxy lands on main's network (a shared data
  // store, a proxy given to main).
  const mainPlan = plans.main ?? [];
  const mainName = "main's networking unchanged: its off-machine preconnects never reach the widgets' proxy";
  if (mainPlan.length === 0) {
    info(mainName, "n/a: main has no off-machine targets on this OS");
  } else {
    const preconnects = mainPlan.filter((a) => a.rel === "preconnect");
    const missing = mainPlan.filter((t) => !tried.main.some((a) => a.id === t.id && a.scheme === t.scheme && a.rel === t.rel));
    const proxied = preconnects.filter((a) => proxyLog.named.has(authorityKey(a.authority)));
    check(
      mainName,
      missing.length === 0 && proxied.length === 0,
      [
        `main tried ${preconnects.map((a) => `${a.scheme}://${a.authority}`).join(", ")}`,
        missing.length > 0 ? `not attempted: ${missing.map((a) => `${a.id} ${a.scheme}`).join(", ")}` : "",
        proxied.length === 0 ? "0 in the proxy log" : `in the proxy log: ${proxied.map((a) => a.authority).join(", ")}`,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }

  // DNS: only where CI routed the probe's zone to its listener.
  const dnsRow = "DNS: the probe's zone reaches its listener (positive control: main's names are looked up there)";
  if (!report.dns) {
    info("DNS: widgets' names looked up", "not measured in this run: no resolver route to the probe's DNS listener (CI routes one on macOS and Windows)");
  } else if (report.dns.error) {
    check(dnsRow, false, `the DNS listener didn't start: ${report.dns.error}`);
  } else {
    const mainNames = mainPlan.filter((a) => String(a.host).endsWith(report.dns.zone));
    const byName = (name) => queries.filter((q) => q.name === String(name).toLowerCase()).length;
    const control = mainNames.find((a) => a.id === "dns-name");
    const prefetch = mainNames.find((a) => a.id === "dns-prefetch");
    check(
      dnsRow,
      control !== undefined && byName(control.host) >= 1,
      control === undefined
        ? "main has no name in the zone"
        : `${dnsQueries(byName(control.host))} for ${control.host}; main's dns-prefetch name: ${prefetch ? dnsQueries(byName(prefetch.host)) : "not planned"}; ${dnsQueries(queries.length)} in all`,
    );
  }
}

function summarizeHits(hits) {
  const counts = {};
  for (const h of hits) counts[h.vector] = (counts[h.vector] ?? 0) + 1;
  return Object.entries(counts)
    .map(([vector, n]) => `${vector} ×${n}`)
    .join(", ");
}

function describeChannels(channels = {}) {
  const present = Object.entries(channels)
    .filter(([, value]) => value)
    .map(([name]) => name);
  return present.length === 0 ? "none present" : `present (allowed): ${present.join(", ")}`;
}

function sample(commands) {
  const first = commands.find((c) => ACL_REJECTION.test(c.message));
  return first ? `e.g. "${first.message}"` : "";
}


/** A markdown table of the checks, for the job summary and the PR. */
export function toMarkdown(title, checks) {
  const failed = checks.filter((c) => !c.ok && c.blocking);
  const verdict = agentVerdict(checks);
  const lines = [
    `### ${title}: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length})`}`,
    "",
    verdict.noWebview
      ? "Agent-made widgets stay off: this OS has no widget webview in v0, so only the switch and main's checks apply."
      : verdict.mayTurnOn
        ? checks.some((c) => c.residual)
          ? "Agent-made widgets: every gate passes here, so the owner may turn them on for this OS, with the warning for the owner-accepted residual (ℹ️ rows below)."
          : "Agent-made widgets: the probe passes in full here, so the owner may turn them on for this OS."
        : `Agent-made widgets must stay **off** on this OS. Failing: ${verdict.why}.`,
    "",
    "✅ pass · ❌ fail · ⛔ fail that keeps agent-made widgets off (the switch is off, so the run continues) · ℹ️ recorded only",
    "",
    "| | Check | Detail |",
    "| --- | --- | --- |",
  ];
  for (const c of checks) {
    const mark = c.info ? "ℹ️" : c.ok ? "✅" : c.blocking ? "❌" : "⛔";
    lines.push(`| ${mark} | ${c.id} | ${String(c.detail).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 600)} |`);
  }
  return `${lines.join("\n")}\n`;
}
