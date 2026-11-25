// Main window: it opens with the title "rlx", and its header shows the r\x mark drawn from
// src/assets/rlx-logo.svg's own path data.
//
// One file per screen check: export `name` and `run(ctx)`; e2e/native/run.mjs runs every
// file in this folder in name order. ctx is { session, shot, shotElement, assert, logoPaths,
// os }; see run.mjs.

export const name = "main-window";

export async function run({ session, shot, shotElement, assert, logoPaths }) {
  const mark = await session.waitFor('header svg[aria-label="rlx"]');

  // The native window's title, from Tauri's window API (main holds core:default).
  const title = await session.evaluate('window.__TAURI_INTERNALS__.invoke("plugin:window|title", { label: "main" })');
  assert.equal(title, "rlx", "native window title");
  assert.equal(await session.title(), "rlx", "document title");

  const paths = await session.execute(
    'return [...arguments[0].querySelectorAll("path")].map((p) => p.getAttribute("d"));',
    [mark],
  );
  assert.deepEqual(paths, logoPaths, "the header mark uses rlx-logo.svg's paths");
  const box = await session.execute(
    "const r = arguments[0].getBoundingClientRect(); return { w: r.width, h: r.height };",
    [mark],
  );
  assert.ok(box.w > 0 && box.h > 0, `the header mark is visible (${box.w}x${box.h})`);

  await shot("main-window");
  // The header, not the bare <svg>: WebKitWebDriver snapshots a lone SVG element as black.
  await shotElement(await session.waitFor("header"), "header");
}
