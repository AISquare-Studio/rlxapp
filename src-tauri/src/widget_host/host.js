// rlx widget host page (docs/architecture.md §5.3). It runs in the `widgets` child webview,
// which has no capability, and the core drives it only by evaluating the two functions on
// window.__rlxHost. It never calls the core itself.
//
// Each widget gets an <iframe sandbox="allow-scripts">, with no allow-same-origin, so its
// origin is opaque: no cookies, no storage and no access to this page. The host sends it
// `init` plus a MessagePort, and accepts messages only on that port.
"use strict";

(() => {
  // The host runs only as the webview's top frame. A copy loaded inside a widget frame does
  // nothing, and could never get the host token anyway (it arrives by eval, top frame only).
  if (window.top !== window) return;
  const grid = document.getElementById("grid");
  let hostToken = null;
  const mounted = new Map();
  const RATE_PER_SECOND = 20;

  function validEntry(entry) {
    return (
      entry &&
      typeof entry.id === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) &&
      Number.isInteger(entry.version) &&
      typeof entry.url === "string" &&
      entry.url.startsWith(location.origin + "/" + entry.id + "/")
    );
  }

  function mountOne(entry) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = typeof entry.title === "string" ? entry.title : entry.id;
    frame.dataset.widgetId = entry.id;
    frame.src = entry.url;

    const record = { id: entry.id, frame, port: null, budget: RATE_PER_SECOND, last: Date.now() };
    frame.addEventListener("load", () => {
      const channel = new MessageChannel();
      record.port = channel.port1;
      record.port.onmessage = (event) => receive(record, event.data);
      const init = { type: "init", v: 1, widgetId: entry.id, settings: {}, state: {}, theme: {} };
      // The frame's origin is opaque, so the target can only be "*".
      frame.contentWindow.postMessage(init, "*", [channel.port2]);
    });
    grid.append(frame);
    mounted.set(entry.id, record);
  }

  // Messages from a widget (FromWidget, §5.2): rate-limited, shape-checked, then POSTed to
  // the core's action route, which validates them again. This page never calls the core
  // any other way.
  function receive(record, message) {
    const now = Date.now();
    record.budget = Math.min(RATE_PER_SECOND, record.budget + ((now - record.last) / 1000) * RATE_PER_SECOND);
    record.last = now;
    if (record.budget < 1) return;
    record.budget -= 1;
    if (!message || typeof message !== "object" || message.v !== 1 || typeof message.type !== "string") return;
    if (!hostToken) return;
    fetch("/host/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Rlx-Host-Token": hostToken },
      body: JSON.stringify({ widgetId: record.id, message }),
    }).catch(() => {});
  }

  window.__rlxHost = Object.freeze({
    /**
     * Mounts widgets: [{ id, version, url, title }]. Entries off this origin are ignored.
     * The first call also hands over the launch's host token, which every action carries.
     */
    mount(entries, token) {
      if (hostToken === null && typeof token === "string" && token) hostToken = token;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (validEntry(entry) && !mounted.has(entry.id)) mountOne(entry);
      }
    },
    /** Sends validated data from the core to one widget. */
    data(id, payload) {
      const record = mounted.get(id);
      if (record && record.port) {
        record.port.postMessage({ type: "data", v: 1, data: payload, fetchedAt: new Date().toISOString(), stale: false });
      }
    },
  });
})();
