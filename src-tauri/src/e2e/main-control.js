// Isolation probe, main-webview controls (test builds only; see src/e2e/mod.rs). The core
// evaluates this in main once it has loaded, then reads window.__rlxMainProbe.
(async () => {
  const out = { canary: null, frameSrc: null, actionRoute: null, preconnect: null, reach: [], rtc: null, done: false };
  window.__rlxMainProbe = out;
  const errorText = (error) => (error && (error.message || error.name)) || String(error);

  // Positive control: main holds the canary grant, so this call must be recorded. Without it,
  // the widgets' "0 calls" would prove nothing.
  try {
    out.canary = { result: "resolved", value: await window.__TAURI_INTERNALS__.invoke("e2e_canary", { from: "main-control" }) };
  } catch (error) {
    out.canary = { result: "rejected", message: errorText(error) };
  }

  // Main's CSP has frame-src 'none': an iframe of a widget URL must be refused.
  out.frameSrc = await new Promise((done) => {
    const finish = (value) => done(value);
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "frame-src" || String(event.violatedDirective).startsWith("frame-src")) {
        finish(`blocked: ${event.effectiveDirective}`);
      }
    });
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = "__RLX_WIDGET_URL__";
    document.body.append(frame);
    setTimeout(() => {
      frame.remove();
      finish("not blocked within 3 s");
    }, 3000);
  });

  // Main must not reach the widgets' action route (its CSP blocks it, and the route accepts
  // only the widgets label).
  try {
    const response = await fetch("__RLX_ACTION_URL__", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetId: "main", message: { type: "refresh", v: 1 } }),
    });
    out.actionRoute = `response ${response.status}`;
  } catch (error) {
    out.actionRoute = `rejected ${errorText(error)}`;
  }

  // Positive control: main's preconnect works at all (CSP doesn't govern it), so it reaches
  // the control listener. Without it, "main's preconnects never reach the proxy" below would
  // prove nothing.
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = "http://127.0.0.1:__RLX_CONTROL_PORT__/main/preconnect";
  document.head.append(link);
  out.preconnect = "added";
  // And off the machine, to main's own TEST-NET address (and, where CI routes the probe's DNS
  // zone, main's names in it): none may ever reach the widgets webview's proxy, whose
  // CONNECT log would name it. On macOS this is the check that can fail, since macOS never
  // proxies loopback. Main's zone names are also the DNS route's positive control.
  for (const target of __RLX_MAIN_REACH__) {
    const reach = document.createElement("link");
    reach.rel = target.rel;
    reach.href = target.url;
    out.reach.push({ ...target, at: Date.now() });
    document.head.append(reach);
    await new Promise((done) => setTimeout(done, 250));
  }

  // Control for the listener: CSP doesn't govern WebRTC, so where main has RTCPeerConnection
  // its STUN requests should reach the control listener. That shows the probe listener would
  // see a widget's.
  const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Peer) {
    out.rtc = "no RTCPeerConnection";
  } else {
    try {
      const peer = new Peer({ iceServers: [{ urls: "stun:127.0.0.1:__RLX_CONTROL_PORT__" }] });
      peer.createDataChannel("control");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((done) => {
        peer.onicegatheringstatechange = () => peer.iceGatheringState === "complete" && done();
        setTimeout(done, 5000);
      });
      out.rtc = `gathering ${peer.iceGatheringState}`;
      peer.close();
    } catch (error) {
      out.rtc = `threw ${errorText(error)}`;
    }
  }
  out.done = true;
})();
