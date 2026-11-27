import { expect, test } from "@playwright/test";
import { openShell } from "./helpers.ts";

// The agents vision, end to end in the browser preview (amendment acceptance A-G).

test("A, B: a chat layout with agents as channels, and an Agents section with running, scheduled and asleep agents", async ({ page }) => {
  await openShell(page);
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Agent channels" }).getByRole("button").first()).toHaveAccessibleName("Manager, setup assistant");
  const channels = page.getByRole("list", { name: "Agent channels" });
  await expect(channels.getByRole("button", { name: "GTM agent, Running" })).toBeVisible();
  await expect(channels.getByRole("button", { name: "Meetings agent, Scheduled 08:45" })).toBeVisible();
  await expect(channels.getByRole("button", { name: "Slack agent, Asleep" })).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.locator("[data-testid=shell-body] > [data-pane]")).toHaveCount(2);

  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "Agents", exact: true }).click();
  const meetings = page.getByTestId("agent-row-meetings-agent");
  await expect(meetings).toContainText("Next wake");
  await meetings.getByText("Details").click();
  await expect(meetings.getByText("Found 2 promises", { exact: false })).toBeVisible();
  await expect(meetings.getByText("Meet transcripts (Google Drive)")).toBeVisible();
  await expect(meetings.getByRole("button", { name: "Wake Meetings agent now" })).toBeVisible();
  await meetings.getByRole("button", { name: "More actions for Meetings agent" }).click();
  for (const item of ["Pause", "Edit", "Open channel"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-row-gtm-agent")).toContainText("Running");
});

test("C, D, E: create Start of day with the manager, Simulate 9:00, then the draft and needs-context cards", async ({ page }) => {
  await openShell(page);
  await page.getByRole("button", { name: "Manager, setup assistant" }).click();
  await page.getByLabel("Message Manager").fill("Every weekday at 9 give me a start of day briefing");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const proposal = page.getByTestId("proposal-card");
  const chips = proposal.getByRole("list", { name: "Connectors" });
  await expect(chips.getByRole("listitem")).toHaveText(["Google Calendar", "Meet transcripts (Google Drive)", "Gmail", "Slack"]);
  await expect(proposal.getByText(/Weekdays at 09:00 · Loud/)).toBeVisible();
  await proposal.getByRole("button", { name: "Remove Gmail" }).click();
  await proposal.getByLabel("Add a connector").selectOption("Gmail");
  await proposal.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("messages").getByText(/Start of day is scheduled for weekdays at 09:00/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Agent channels" }).getByRole("button", { name: "Start of day, Scheduled 09:00" })).toBeVisible();

  await page.getByRole("button", { name: "Dashboard" }).click();
  const section = page.getByRole("region", { name: "Start of day" });
  await section.getByRole("button", { name: /Simulate 9:00/ }).click();
  const notice = page.getByRole("alert", { name: "Notification: Start of day" });
  await expect(notice).toContainText("3 to do now");
  for (const name of ["Do now", "Today", "Waiting on you"]) await expect(section.getByRole("region", { name })).toBeVisible();
  await expect(section.getByRole("region", { name: "Do now" }).getByRole("link").first()).toHaveAttribute("href", /example\.com/);

  await notice.getByRole("button", { name: "Open" }).click();
  const messages = page.getByTestId("messages");
  await expect(messages).toContainText("Good morning Sam");
  const draft = messages.getByTestId("email-draft-card").first();
  await expect(draft.getByTestId("sign-off")).toHaveText("— Nova, Sam Rivera's AI Agent");
  await expect(draft.getByRole("button", { name: /Send/ })).toHaveCount(0);
  await draft.getByRole("button", { name: "More actions for the draft to Finance Team" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await page.keyboard.press("Escape");
  await draft.getByRole("button", { name: "Approve" }).click();
  await draft.getByRole("button", { name: /Send/ }).click();
  await expect(draft).toContainText("Sent");

  const ask = messages.getByTestId("needs-context-card");
  await ask.getByRole("button", { name: "I'm free Tuesday at 11:00 or Wednesday at 15:00" }).click();
  await expect(messages.getByTestId("email-draft-card").last()).toContainText(
    "Ravi, great to meet you. I'm free Tuesday at 11:00 or Wednesday at 15:00. Let me know what works for you.",
  );
});

test("F: the Slack widget refreshes silently with no model turn, and takes one when something is new", async ({ page }) => {
  await openShell(page);
  const slack = page.getByRole("region", { name: "Slack digest" });
  await expect(slack.getByTestId("slack-turn")).toHaveText("Claude reviewed 3 new");
  await slack.getByRole("button", { name: "More actions for Slack digest" }).click();
  await page.getByRole("menuitem", { name: "Refresh now" }).click();
  await expect(slack.getByTestId("slack-turn")).toHaveText("Nothing new, no Claude usage");
  await slack.getByRole("button", { name: "More actions for Slack digest" }).click();
  await page.getByRole("menuitem", { name: "New messages arrive (demo)" }).click();
  await expect(slack.getByTestId("slack-turn")).toHaveText("Claude reviewed 3 new");
});

test("G: no raw run logs outside Developer mode", async ({ page }) => {
  await openShell(page);
  await expect(page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "Developer" })).toHaveCount(0);
  await page.getByRole("button", { name: "GTM agent, Running" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "# gtm-agent" })).toBeVisible();
  await expect(page.getByTestId("task-log")).toHaveCount(0);
  await expect(page.getByTestId("messages")).not.toContainText("Reading #sales");
});
