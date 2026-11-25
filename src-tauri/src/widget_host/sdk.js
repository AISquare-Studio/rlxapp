// rlx widget SDK. The core inlines it ahead of every widget document, after the CSP <meta>.
//
// The host posts { type: "init", v: 1, ... } with one MessagePort. The SDK takes init once,
// and only from window.parent, so a later or foreign message can't swap the port. Widgets use:
//   rlx.on((message) => { ... })   every ToWidget message (init, data, status), §5.2
//   rlx.send({ type: "refresh", v: 1 })   a FromWidget message, §5.2
(() => {
  "use strict";
  let port = null;
  const handlers = new Set();
  const deliver = (message) => {
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(error);
      }
    }
  };
  window.addEventListener("message", (event) => {
    if (port || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== "init" || data.v !== 1 || !event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = (message) => deliver(message.data);
    deliver(data);
  });
  Object.defineProperty(window, "rlx", {
    value: Object.freeze({
      on(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      send(message) {
        if (port) port.postMessage(message);
      },
    }),
  });
})();
