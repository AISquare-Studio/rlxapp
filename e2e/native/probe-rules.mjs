// The isolation probe's rules (docs/architecture.md §5.3): one rule for every channel on
// every OS. `evaluate` turns the report the test build writes (src-tauri/src/e2e/) into
// checks. Any failed check fails the run.
//
// What the rules never assert: that a raw channel (__TAURI_INTERNALS__, chrome.webview,
// webkit.messageHandlers, the ipc:// fetch) is absent. Channels may exist and may deliver.
// What must hold is that nothing they carry runs: every command is rejected (by the missing
// key or the ACL), and the canary records no call from a widget.

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

  if (!report || report.schema !== 3) {
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
  check(
    "canary: 0 calls from widgets",
    stray.length === 0,
    stray.length === 0 ? "0 calls" : stray.map((c) => `${c.from} via ${c.webview}`).join(", "),
  );

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
      `${label}: 0 connections (fetch, XHR, WebSocket, EventSource, beacon, img, CSS, fonts, SVG, prefetch, preload, ping, WebRTC, navigation, refresh)`,
      contract.length === 0,
      (contract.length === 0 ? "0 connections, 0 datagrams" : summarizeHits(contract)) +
        (policy.widgetWebview ? "" : " (probe-only webview: the product attaches none on this OS)"),
    );
    gate(
      `${label}: 0 preconnect/dns-prefetch connections`,
      silent.length === 0,
      silent.length === 0 ? "0 connections" : `${silent.length} TCP connection(s) that sent nothing: ${summarizeHits(silent)}`,
    );
  }
  const controlHits = listeners.control?.hits ?? [];
  info("listener control (main WebRTC)", `${main.rtc ?? "not run"}; control listener saw ${controlHits.length}`);
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
    if (!probed) return checks;
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
    const frameCommands = frame.commands ?? [];
    const ran = frameCommands.filter((c) => c.result === "resolved" || (c.result === "rejected" && !ACL_REJECTION.test(c.message)));
    check(
      "widget iframe: every command rejected",
      ran.length === 0,
      frameCommands.length === 0
        ? "no invoke() in the iframe; raw channels only (see the canary)"
        : ran.length === 0
          ? `${frameCommands.length} attempted: ${tally(frameCommands)}`
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
  (policy.widgetWebview ? check : gate)(
    "self-navigation off the widget scheme blocked",
    after && typeof after.href === "string" && after.href === host.href && after.frames === report.framesBeforeNavigation,
    after ? `host still at ${after.href}, ${after.frames} frames` : "host page gone after navigating",
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

function tally(commands) {
  const counts = {};
  for (const c of commands) counts[c.result] = (counts[c.result] ?? 0) + 1;
  return Object.entries(counts)
    .map(([result, n]) => `${n} ${result}`)
    .join(", ");
}

/** A markdown table of the checks, for the job summary and the PR. */
export function toMarkdown(title, checks) {
  const failed = checks.filter((c) => !c.ok && c.blocking);
  const verdict = agentVerdict(checks);
  const lines = [
    `### ${title}: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length})`}`,
    "",
    verdict.mayTurnOn
      ? "Agent-made widgets: the probe passes in full here, so the owner may turn them on for this OS."
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
