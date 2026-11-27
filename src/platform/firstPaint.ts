import type { PaintSource } from "./index.ts";

export interface FirstPaint {
  /** Wall-clock time of the first paint, Unix epoch in ms. */
  epochMs: number;
  source: PaintSource;
}

/**
 * Resolves once the page has painted content for the first time.
 *
 * Prefers the browser's First Contentful Paint entry (WebKit, WebKitGTK and
 * WebView2 all support it), which is timed against `performance.timeOrigin`
 * and therefore convertible to wall-clock time. Falls back to the frame after
 * the first animation frame when paint timing is unavailable.
 */
export function whenFirstPaint(): Promise<FirstPaint> {
  const supportsPaintTiming =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("paint");

  if (!supportsPaintTiming) {
    return afterNextFrame();
  }

  return new Promise((resolve) => {
    const observer = new PerformanceObserver((list) => {
      const fcp = list.getEntriesByName("first-contentful-paint")[0];
      if (fcp) {
        observer.disconnect();
        resolve({ epochMs: performance.timeOrigin + fcp.startTime, source: "fcp" });
      }
    });
    observer.observe({ type: "paint", buffered: true });
  });
}

function afterNextFrame(): Promise<FirstPaint> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve({ epochMs: performance.timeOrigin + performance.now(), source: "raf" });
      });
    });
  });
}
