// Runs at document start in every frame of the `widgets` webview (the host page and every
// widget iframe), before any page script. Installed by widget_host::attach.
//
// CSP doesn't govern WebRTC: without this, RTCPeerConnection's STUN/TURN requests reach any
// host from a widget whose CSP says connect-src 'none'. The isolation probe found exactly that
// on macOS. So the WebRTC interfaces are removed from these frames. A sandboxed widget can't
// get them back: it has no same-origin child frame (frame-src 'none', and sandboxed frames are
// cross-origin to each other) and no popups.
(() => {
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!/^(webkit|moz)?RTC/.test(name)) continue;
    try {
      delete window[name];
    } catch {
      // not configurable: fall through and shadow it
    }
    if (name in window) {
      try {
        Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
      } catch {
        // left as is; the isolation probe reports it
      }
    }
  }
})();
