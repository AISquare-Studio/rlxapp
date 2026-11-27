/** FakeCore's mock host data: one draft, two standing approvals, one sent item and the manager's hello. */
import { GMAIL, SLACK } from "../connectors.ts";
import { MANAGER_ID } from "../../state/agents.ts";
import { signOffText, type ActivityItem, type Draft, type Message, type Settings, type StandingApproval } from "../../state/model.ts";

const HOUR = 3_600_000;

export interface SeedData {
  drafts: Draft[];
  approvals: StandingApproval[];
  activity: ActivityItem[];
  messages: Message[];
}

export function seedData(settings: Pick<Settings, "agentName" | "ownerName">, now: number): SeedData {
  return {
    drafts: [
      {
        id: "d-seed-1",
        status: "pending",
        origin: "task",
        connector: SLACK,
        destination: "#launch",
        body: "I can own the press kit. I'll have a first version in this channel by Thursday.",
        createdAt: now - HOUR / 2,
        context: "From the task “Triage my inbox and draft replies”",
      },
    ],
    approvals: [
      {
        id: "apr-ci-green",
        instruction: "When CI on main is green, post in #dev asking for approval to deploy.",
        connector: SLACK,
        destination: "#dev",
        trigger: "When CI on main reports success",
        expiry: "once",
        maxChars: 280,
        status: "active",
        confirmedAt: now - 3 * HOUR,
      },
      {
        id: "apr-slots",
        instruction: "Answer Priya's meeting-time questions with my free slots.",
        connector: SLACK,
        destination: "DM with Priya Shah",
        trigger: "When Priya asks for a meeting time",
        expiry: "untilRevoked",
        maxChars: 200,
        status: "active",
        confirmedAt: now - 26 * HOUR,
      },
    ],
    activity: [
      {
        id: "act-seed-1",
        at: now - 5 * HOUR,
        connector: GMAIL,
        destination: "Finance Team",
        subject: "Re: Expense report",
        body: "Thanks, the receipts are attached. Let me know if anything is missing.",
        signOff: signOffText(settings.agentName, settings.ownerName),
        approvedBy: "owner",
      },
    ],
    messages: [
      {
        id: "m-manager-hello",
        channel: MANAGER_ID,
        from: "agent",
        at: now - 2 * HOUR,
        text: `Hi ${settings.ownerName.split(" ")[0] ?? ""}, I set up your agents. Tell me what you want done and when, and I'll propose an agent for it. Try: “Every weekday at 9, give me a start of day briefing.”`,
      },
    ],
  };
}
