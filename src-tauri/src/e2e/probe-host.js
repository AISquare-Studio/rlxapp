// Isolation probe, host-page side (test builds only; see src/e2e/mod.rs).
//
// It runs in the `widgets` webview next to host.js and records what the host page can reach.
// It also collects the fixture iframe's own report. The core reads `__rlxProbe.report` by
// evaluating it once `done` is set, then calls `__rlxProbe.navigate()`, the last step.
"use strict";

(() => {
  const CONFIG = __RLX_PROBE_CONFIG__;
  const LISTENER = `http://127.0.0.1:${CONFIG.port}`;
  const FROM = "widgets-host";

  const report = {
    from: FROM,
    href: location.href,
    origin: location.origin,
    done: false,
    channels: {},
    commands: [],
    channelFetch: null,
    raw: [],
    connections: [],
    iframe: null,
    ran: [],
    errors: [],
  };

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const errorText = (error) => (error && (error.message || error.name)) || String(error);

  /** Settles `promise` into { result, message }, or "timeout" after `ms`. */
  function settle(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ result: "resolved", message: JSON.stringify(value) ?? "undefined" }),
        (error) => ({ result: "rejected", message: errorText(error) }),
      ),
      sleep(ms).then(() => ({ result: "timeout", message: `no response in ${ms} ms` })),
    ]);
  }

  function channels() {
    return {
      tauriInternals: typeof window.__TAURI_INTERNALS__ === "object",
      tauriInvoke: typeof (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) === "function",
      windowIpc: typeof (window.ipc && window.ipc.postMessage) === "function",
      chromeWebview: typeof (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) === "function",
      webkitIpc: typeof (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc) === "object",
    };
  }

  // Every app and plugin command, through Tauri's own keyed invoke().
  async function invokeEverything() {
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof invoke !== "function") {
      report.errors.push("no __TAURI_INTERNALS__.invoke on the host page");
      return;
    }
    const outcomes = await Promise.all(
      CONFIG.commands.map(async (cmd) => {
        const args = cmd === "e2e_canary" ? { from: `${FROM}-invoke` } : {};
        return { cmd, ...(await settle(invoke(cmd, args), 8000)) };
      }),
    );
    report.commands = outcomes;
    report.channelFetch = { cmd: CONFIG.channelFetch, ...(await settle(invoke(CONFIG.channelFetch, {}), 8000)) };
  }

  // Raw channels, bypassing invoke(): a canary call with a key the page doesn't have.
  async function rawChannels() {
    const message = (channel) =>
      JSON.stringify({
        cmd: "e2e_canary",
        callback: 1,
        error: 2,
        options: {},
        payload: { from: `${FROM}-raw-${channel}` },
        __TAURI_INVOKE_KEY__: `rlx-probe-${FROM}-${channel}`,
      });
    const attempt = async (channel, send) => {
      try {
        const value = await send();
        report.raw.push({ channel, outcome: value === undefined ? "sent" : String(value) });
      } catch (error) {
        report.raw.push({ channel, outcome: `threw ${errorText(error)}` });
      }
    };
    await attempt("webkit", () =>
      window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc
        ? window.webkit.messageHandlers.ipc.postMessage(message("webkit"))
        : "absent",
    );
    await attempt("chrome", () =>
      window.chrome && window.chrome.webview ? window.chrome.webview.postMessage(message("chrome")) : "absent",
    );
    await attempt("window.ipc", () => (window.ipc ? window.ipc.postMessage(message("window.ipc")) : "absent"));
    // The action route without the host token (the probe can't read it from host.js's
    // closure, just as a widget can't): refused (403).
    await attempt("action-route (no token)", () =>
      fetch("/host/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widgetId: "e2e-probe", message: { type: "invoke", v: 1, cmd: "app_info" } }),
      }).then(
        async (response) => `response ${response.status} ${(await response.text()).slice(0, 120)}`.trim(),
        (error) => `rejected ${errorText(error)}`,
      ),
    );
    for (const url of ["ipc://localhost/e2e_canary", "http://ipc.localhost/e2e_canary"]) {
      await attempt(url, () =>
        fetch(url, {
          method: "POST",
          body: JSON.stringify({ from: `${FROM}-raw-fetch` }),
          headers: {
            "Content-Type": "application/json",
            "Tauri-Callback": "1",
            "Tauri-Error": "2",
            "Tauri-Invoke-Key": `rlx-probe-${FROM}-fetch`,
          },
        }).then(
          (response) => `response ${response.status}`,
          (error) => `rejected ${errorText(error)}`,
        ),
      );
    }
  }

  async function connections() {
    const tag = (kind) => `${LISTENER}/${FROM}/${kind}`;
    const out = report.connections;
    const attempt = async (kind, run) => {
      const at = Date.now();
      try {
        out.push({ kind, at, outcome: String(await run()) });
      } catch (error) {
        out.push({ kind, at, outcome: `threw ${errorText(error)}` });
      }
    };
    const event = (target, ok, bad, ms = 3000) =>
      new Promise((done) => {
        target[ok] = () => done(ok);
        target[bad] = () => done(bad);
        setTimeout(() => done("timeout"), ms);
      });
    await attempt("fetch", () => fetch(tag("fetch"), { mode: "no-cors" }).then(() => "resolved", (e) => `rejected ${errorText(e)}`));
    await attempt("xhr", () => {
      const xhr = new XMLHttpRequest();
      const result = event(xhr, "onload", "onerror");
      xhr.open("GET", tag("xhr"));
      xhr.send();
      return result;
    });
    await attempt("websocket", () => event(new WebSocket(tag("websocket").replace("http:", "ws:")), "onopen", "onerror"));
    await attempt("eventsource", () => {
      const source = new EventSource(tag("eventsource"));
      return event(source, "onopen", "onerror").finally(() => source.close());
    });
    await attempt("beacon", () => navigator.sendBeacon(tag("beacon"), "x"));
    await attempt("img", () => {
      const img = new Image();
      const result = event(img, "onload", "onerror");
      img.src = tag("img");
      return result;
    });
    for (const rel of ["preconnect", "dns-prefetch", "prefetch", "preload", "modulepreload"]) {
      await attempt(rel, () => {
        const link = document.createElement("link");
        link.rel = rel;
        if (rel === "preload") link.as = "fetch";
        link.href = tag(rel);
        document.head.append(link);
        return "added";
      });
    }
    // Subresources CSP must stop: CSS url(), @import and @font-face, and SVG <image>.
    await attempt("css-url", () => {
      const div = document.createElement("div");
      div.style.backgroundImage = `url(${tag("css-url")})`;
      div.style.width = div.style.height = "4px";
      document.body.append(div);
      return "added";
    });
    await attempt("css-import-font", () => {
      const style = document.createElement("style");
      style.textContent = "@import url(" + tag("css-import") + ");" +
        "@font-face{font-family:rlxprobe;src:url(" + tag("font-face") + ")}" +
        ".rlxprobe-font{font-family:rlxprobe}";
      document.head.append(style);
      const span = document.createElement("span");
      span.className = "rlxprobe-font";
      span.textContent = "x";
      document.body.append(span);
      return "added";
    });
    await attempt("svg-image", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
      image.setAttribute("href", tag("svg-image"));
      svg.append(image);
      document.body.append(svg);
      return "added";
    });

    await attempt("rtc", () => rtc(CONFIG.port));
  }

  async function rtc(port) {
    const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Peer) return "no RTCPeerConnection";
    const peer = new Peer({
      iceServers: [
        { urls: `stun:127.0.0.1:${port}` },
        { urls: [`turn:127.0.0.1:${port}?transport=udp`, `turn:127.0.0.1:${port}?transport=tcp`], username: "probe", credential: "probe" },
      ],
    });
    peer.createDataChannel("probe");
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((done) => {
      peer.onicegatheringstatechange = () => peer.iceGatheringState === "complete" && done();
      setTimeout(done, 5000);
    });
    const state = peer.iceGatheringState;
    peer.close();
    return `gathering ${state}`;
  }

  // Reports from the widgets this page mounted. Only these frames' windows are trusted.
  window.addEventListener("message", (event) => {
    const frame = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === event.source);
    if (!frame || !event.data) return;
    if (event.data.type === "e2e-ran") report.ran.push({ frame: frame.dataset.widgetId, id: String(event.data.id) });
    if (event.data.type === "e2e-probe-report" && frame.dataset.widgetId === CONFIG.fixture) report.iframe = event.data.report;
  });

  async function main() {
    report.channels = channels();
    await invokeEverything();
    await rawChannels();
    await connections();
    // The core mounts the widgets; wait for the fixture's report and for every control.
    const deadline = Date.now() + 60_000;
    while (!report.iframe && Date.now() < deadline) await sleep(200);
    if (!report.iframe) report.errors.push("the fixture iframe never reported");
    await sleep(3000); // time for a (refused) agent-made widget to have run
    report.frames = [...document.querySelectorAll("iframe")].map((f) => ({
      id: f.dataset.widgetId,
      sandbox: f.getAttribute("sandbox"),
      src: f.getAttribute("src"),
    }));
    report.done = true;
  }

  window.__rlxProbe = Object.freeze({
    report,
    /** The last step: every navigation the page and the fixture can try. */
    navigate() {
      // The navigation step's evidence: the fixture's ack, and every frame-src violation
      // this page sees (the fixture's self-navigation is blocked as a violation here).
      report.navigation = { ack: null, violations: [] };
      document.addEventListener("securitypolicyviolation", (event) => {
        report.navigation.violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
      window.addEventListener("message", (event) => {
        const fixtureFrame = [...document.querySelectorAll("iframe")].find((f) => f.dataset.widgetId === CONFIG.fixture);
        if (fixtureFrame && event.source === fixtureFrame.contentWindow && event.data && event.data.type === "e2e-navigating") {
          report.navigation.ack = Array.isArray(event.data.urls) ? event.data.urls.map(String) : [];
        }
      });
      const fixture = [...document.querySelectorAll("iframe")].find((f) => f.dataset.widgetId === CONFIG.fixture);
      if (fixture && fixture.contentWindow) fixture.contentWindow.postMessage({ type: "e2e-navigate" }, "*");
      setTimeout(() => {
        try {
          window.open(`${LISTENER}/${FROM}/window-open`);
        } catch {
          // blocked, as expected
        }
        location.href = `${LISTENER}/${FROM}/navigate`;
      }, 1500);
    },
  });

  main().catch((error) => {
    report.errors.push(`probe crashed: ${errorText(error)}`);
    report.done = true;
  });
})();
