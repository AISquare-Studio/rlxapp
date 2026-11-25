// rlx widget host page (docs/architecture.md §5.3). It runs in the `widgets` child webview,
// which has no capability, and the core drives it only by evaluating the two functions on
// window.__rlxHost. It never calls the core except through the action route.
//
// Each widget gets an <iframe sandbox="allow-scripts">, with no allow-same-origin, so its
// origin is opaque: no cookies, no storage and no access to this page. The host sends it
// `init` plus a MessagePort, and accepts messages only on that port.
//
// The core replays the mounted set and every widget's latest data after each page load (see
// src/widget_host/state.rs), so this page keeps no state of its own that a reload could lose.
"use strict";

(() => {
  // The host runs only as the webview's top frame. A copy loaded inside a widget frame does
  // nothing, and could never get the host token anyway (it arrives by eval, top frame only).
  if (window.top !== window) return;
  const grid = document.getElementById("grid");
  const mounted = new Map();
  const RATE_PER_SECOND = 20;
  const MAX_QUEUED_ACTIONS = 50;
  // The host token arrives once per page load, with the core's replay. Actions sent before
  // it arrives wait here.
  let hostToken = null;
  const queued = [];

  // Nothing may be dragged into the host page: a dropped link would navigate it.
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (event) => event.preventDefault());
  }

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

  function dataMessage(payload) {
    return { type: "data", v: 1, data: payload, fetchedAt: new Date().toISOString(), stale: false };
  }

  function mountOne(entry) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = typeof entry.title === "string" ? entry.title : entry.id;
    frame.dataset.widgetId = entry.id;
    frame.src = entry.url;

    const record = { id: entry.id, frame, port: null, data: undefined, budget: RATE_PER_SECOND, last: Date.now() };
    // Every load of the frame (the first, or a reload) gets a fresh init, a fresh port and
    // the latest data.
    frame.addEventListener("load", () => {
      if (record.port) record.port.close();
      const channel = new MessageChannel();
      record.port = channel.port1;
      record.port.onmessage = (event) => receive(record, event.data);
      const init = { type: "init", v: 1, widgetId: entry.id, settings: {}, state: {}, theme: {} };
      // The frame's origin is opaque, so the target can only be "*".
      frame.contentWindow.postMessage(init, "*", [channel.port2]);
      if (record.data !== undefined) record.port.postMessage(dataMessage(record.data));
    });
    grid.append(frame);
    mounted.set(entry.id, record);
  }

  function post(body) {
    fetch("/host/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Rlx-Host-Token": hostToken },
      body,
    }).catch(() => {});
  }

  // Messages from a widget (FromWidget, §5.2): rate-limited, shape-checked, then POSTed to
  // the core's action route, which validates them again.
  function receive(record, message) {
    const now = Date.now();
    record.budget = Math.min(RATE_PER_SECOND, record.budget + ((now - record.last) / 1000) * RATE_PER_SECOND);
    record.last = now;
    if (record.budget < 1) return;
    record.budget -= 1;
    if (!message || typeof message !== "object" || message.v !== 1 || typeof message.type !== "string") return;
    const body = JSON.stringify({ widgetId: record.id, message });
    if (hostToken) post(body);
    else if (queued.length < MAX_QUEUED_ACTIONS) queued.push(body);
  }

  window.__rlxHost = Object.freeze({
    /**
     * Mounts widgets: [{ id, version, url, title }]. Entries off this origin are ignored, and
     * a mounted ID stays as it is. Returns the IDs of the entries that are now mounted.
     * The core's replay also hands over the host token, once per page load.
     */
    mount(entries, token) {
      if (hostToken === null && typeof token === "string" && token) {
        hostToken = token;
        queued.splice(0).forEach(post);
      }
      const ids = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!validEntry(entry)) continue;
        if (!mounted.has(entry.id)) mountOne(entry);
        ids.push(entry.id);
      }
      return ids;
    },
    /** Keeps a widget's latest data, and sends it now if the widget's port exists. */
    data(id, payload) {
      const record = mounted.get(id);
      if (!record) return false;
      record.data = payload;
      if (record.port) record.port.postMessage(dataMessage(payload));
      return true;
    },
  });
})();
