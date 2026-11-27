import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.tsx";
import { CHAT_REPLIES } from "../engine/fake/data.ts";
import { browserPlatform } from "../platform/index.ts";
import { DEFAULT_SETTINGS, type Message } from "../state/model.ts";
import { fakeServices } from "../test/fakeServices.ts";
import { MessageAnnouncer } from "./Channel.tsx";

beforeEach(() => localStorage.clear());

const agent = (id: string, text: string, streaming?: boolean): Message => ({ id, channel: "slack-agent", from: "agent", at: 0, text, streaming });

describe("channel announcements (F10)", () => {
  it("announces a new message once it's final, never while it streams, and never what was there when the channel opened", () => {
    const live = () => screen.getByTestId("messages-live").textContent;
    const earlier = agent("m1", "Earlier message");
    const view = render(<MessageAnnouncer messages={[earlier]} />);
    expect(live()).toBe("");

    view.rerender(<MessageAnnouncer messages={[earlier, agent("m2", "", true)]} />);
    expect(live()).toBe("");
    view.rerender(<MessageAnnouncer messages={[earlier, agent("m2", "Three things ", true)]} />);
    expect(live()).toBe("");
    view.rerender(<MessageAnnouncer messages={[earlier, agent("m2", "Three things need you today.", true)]} />);
    expect(live()).toBe("");
    view.rerender(<MessageAnnouncer messages={[earlier, agent("m2", "Three things need you today.", false)]} />);
    expect(live()).toBe("Three things need you today.");

    // The owner's own message isn't read back to them.
    const mine: Message = { id: "m3", channel: "slack-agent", from: "owner", at: 0, text: "Thanks" };
    view.rerender(<MessageAnnouncer messages={[earlier, agent("m2", "Three things need you today."), mine]} />);
    expect(live()).toBe("Three things need you today.");
  });

  it("announces a card by its gist", () => {
    const view = render(<MessageAnnouncer messages={[]} />);
    const card: Message = {
      id: "c1",
      channel: "start-of-day",
      from: "agent",
      at: 0,
      card: { type: "checklist", title: "Before 10:00", items: [{ text: "Reply to Tom", done: false }] },
    };
    view.rerender(<MessageAnnouncer messages={[card]} />);
    expect(screen.getByTestId("messages-live").textContent).toBe("Before 10:00");
  });

  it("keeps the message list itself out of the live region, and announces the agent's reply once", async () => {
    render(<App platform={browserPlatform} {...fakeServices({ settings: { ...DEFAULT_SETTINGS, onboarded: true }, stepMs: 20, seed: false })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Slack agent/ }));
    const list = await screen.findByTestId("messages");
    expect(list.getAttribute("aria-live")).toBeNull();
    expect(list.closest("[aria-live]")).toBeNull();
    const live = screen.getByTestId("messages-live");
    expect(live.getAttribute("aria-live")).toBe("polite");

    fireEvent.change(screen.getByRole("textbox", { name: "Message Slack agent" }), { target: { value: "What needs me today?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    const reply = CHAT_REPLIES[0] ?? "";
    await within(list).findByText(reply.trim());
    await act(async () => {});
    expect(live.textContent?.trim()).toBe(reply.trim());
    expect(live.textContent).not.toMatch(/…|What needs me today/);
  });
});
