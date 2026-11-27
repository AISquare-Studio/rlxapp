import { describe, expect, it } from "vitest";
import { FakeEngine } from "../engine/fake/FakeEngine.ts";
import { DeviceStore } from "./device.ts";
import { FakeCore } from "./fake/FakeCore.ts";
import { DEFAULT_PENDING_MARKER, canAssume, newestSeq, pendingUnread, type PendingItem } from "./pending.ts";

function item(patch: Partial<PendingItem> = {}): PendingItem {
  return {
    id: "p1",
    seq: 1,
    asker: "coder",
    kind: "question",
    title: "Pick a library",
    text: "Which date library?",
    suggested: [{ label: "date-fns" }, { label: "Temporal" }],
    ownerOnly: false,
    createdAt: 0,
    assumeAfter: 1_000,
    status: "open",
    ...patch,
  };
}

describe("Pending rules", () => {
  it("assumes only open items past their time that have an answer to assume, and never owner-only ones", () => {
    expect(canAssume(item(), 999)).toBe(false);
    expect(canAssume(item(), 1_000)).toBe(true);
    expect(canAssume(item({ ownerOnly: true }), 5_000)).toBe(false);
    expect(canAssume(item({ status: "answered" }), 5_000)).toBe(false);
    expect(canAssume(item({ assumeAfter: undefined }), 5_000)).toBe(false);
    expect(canAssume(item({ suggested: [] }), 5_000)).toBe(false);
  });

  it("lights the dot for an open item newer than the marker, unless muted or switched off", () => {
    const items = [item({ seq: 3 }), item({ id: "p2", seq: 5, status: "answered" })];
    expect(newestSeq(items)).toBe(5);
    expect(pendingUnread(items, { ...DEFAULT_PENDING_MARKER, seen: 2 })).toBe(true);
    expect(pendingUnread(items, { ...DEFAULT_PENDING_MARKER, seen: 3 })).toBe(false);
    expect(pendingUnread(items, { seen: 0, muted: true, enabled: true })).toBe(false);
    expect(pendingUnread(items, { seen: 0, muted: false, enabled: false })).toBe(false);
  });

  it("lets the core's manager assume due items, while owner-only ones stay open", () => {
    let clock = 0;
    const core = new FakeCore({ engine: new FakeEngine({ seed: false }), device: new DeviceStore(null), now: () => clock });
    clock = 60 * 60_000;
    core.assumeDue();
    // Every seeded item is an owner-only approval (sending for the owner): none is assumed.
    expect(core.snapshot().pending.every((i) => i.status === "open")).toBe(true);
    core.dispose();
  });
});
