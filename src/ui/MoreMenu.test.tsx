import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { browserPlatform } from "../platform/index.ts";
import { DEFAULT_SETTINGS } from "../state/model.ts";
import { fakeServices } from "../test/fakeServices.ts";
import { MoreMenu } from "./MoreMenu.tsx";

beforeEach(() => localStorage.clear());

function open(label = "More actions") {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.click(trigger);
  return { trigger, items: screen.getAllByRole("menuitem") };
}

describe("the ⋯ menu's keyboard (F9)", () => {
  it("jumps to the first and last item with Home and End", () => {
    render(<MoreMenu label="More actions" items={["Pause", "Edit", "Open channel"].map((label) => ({ label, onSelect: () => {} }))} />);
    const { items } = open();
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    // The arrows still wrap.
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("skips disabled items for Home and End", () => {
    render(
      <MoreMenu
        label="More actions"
        items={[
          { label: "Wake now", disabled: true, onSelect: () => {} },
          { label: "Pause", onSelect: () => {} },
          { label: "Edit", onSelect: () => {} },
        ]}
      />,
    );
    const { items } = open();
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "Home" });
    expect(document.activeElement).toBe(items[1]);
  });

  it("returns focus to the ⋯ button after a choice, and after Escape", () => {
    const pause = vi.fn<() => void>();
    render(<MoreMenu label="More actions" items={[{ label: "Pause", onSelect: pause }, { label: "Edit", onSelect: () => {} }]} />);
    const first = open();
    fireEvent.click(first.items[0]!);
    expect(pause).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(first.trigger);

    const second = open();
    fireEvent.keyDown(second.items[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(second.trigger);
  });

  it("keeps focus on an agent's ⋯ button after Pause, and gives it back when Edit's dialog closes", async () => {
    render(<App platform={browserPlatform} {...fakeServices({ settings: { ...DEFAULT_SETTINGS, onboarded: true }, stepMs: 20 })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const row = await screen.findByTestId("agent-row-meetings-agent");
    const trigger = within(row).getByRole("button", { name: "More actions for Meetings agent" });
    fireEvent.click(trigger);
    fireEvent.click(within(row).getByRole("menuitem", { name: "Pause" }));
    expect(within(row).getByText("Paused")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(within(row).getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Meetings agent" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
