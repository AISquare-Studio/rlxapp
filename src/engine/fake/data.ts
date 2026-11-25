/** Mock data for FakeEngine. Every person here is a placeholder. */
import type { BoardTask, Connector, FleetAgent } from "../types.ts";

export const MOCK_ACCOUNT = "sam.rivera@example.com";

export const CONNECTORS: Connector[] = [
  {
    id: "claude.ai Slack",
    status: "connected",
    tools: [
      { name: "mcp__claude_ai_Slack__slack_search_public", access: "read" },
      { name: "mcp__claude_ai_Slack__slack_read_thread", access: "read" },
      { name: "mcp__claude_ai_Slack__slack_send_message", access: "write" },
    ],
  },
  {
    id: "claude.ai Gmail",
    status: "connected",
    tools: [
      { name: "mcp__claude_ai_Gmail__search_threads", access: "read" },
      { name: "mcp__claude_ai_Gmail__get_thread", access: "read" },
      { name: "mcp__claude_ai_Gmail__create_draft", access: "write" },
    ],
  },
  {
    id: "claude.ai Linear",
    status: "connected",
    tools: [
      { name: "mcp__claude_ai_Linear__list_issues", access: "read" },
      { name: "mcp__claude_ai_Linear__update_issue", access: "unknown" },
    ],
  },
  {
    id: "claude.ai Google Calendar",
    status: "needs-auth",
    tools: [{ name: "mcp__claude_ai_Google_Calendar__list_events", access: "read" }],
  },
];

export interface FeedItem {
  id: string;
  title: string;
  subtitle?: string;
  time?: string;
  url?: string;
  needsYou: boolean;
  why?: string;
}

/** The Feed schema every connector widget renders (architecture §5.5). */
export interface Feed {
  summary: string;
  items: FeedItem[];
  /**
   * What the refresh cost: each interval fetches with no model turn, and Claude reviews only new
   * items (architecture follow-up 14). `reviewed` is how many new items Claude looked at; 0 means
   * nothing new, so no model turn and no Claude usage.
   */
  reviewed?: number;
}

export const SLACK_DIGEST: Feed = {
  summary: "3 things need you across 2 DMs and #launch; 14 other messages summarized.",
  items: [
    {
      id: "s1",
      title: "Priya Shah: “Can you sign off on the pricing page copy before 3pm?”",
      subtitle: "DM",
      time: "10 min ago",
      url: "https://example.com/slack/s1",
      needsYou: true,
      why: "A direct question with a deadline today",
    },
    {
      id: "s2",
      title: "Marco Diaz in #launch: “Who owns the press kit? Sam, is that you?”",
      subtitle: "#launch",
      time: "32 min ago",
      url: "https://example.com/slack/s2",
      needsYou: true,
      why: "You're named as the likely owner, with no @mention",
    },
    {
      id: "s3",
      title: "Lena Fischer replied in your thread about the Q4 roadmap",
      subtitle: "#product",
      time: "1 h ago",
      url: "https://example.com/slack/s3",
      needsYou: true,
      why: "Waiting on your answer to her question about scope",
    },
    {
      id: "s4",
      title: "#general: offsite logistics posted, hotel block closes Friday",
      subtitle: "#general",
      time: "2 h ago",
      needsYou: false,
    },
    {
      id: "s5",
      title: "#eng-updates: 4 deploys today, all green",
      subtitle: "#eng-updates",
      time: "3 h ago",
      needsYou: false,
    },
  ],
};

export interface MailItem {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  time: string;
}

export interface GmailDashboard {
  needsReply: MailItem[];
  importantUnread: MailItem[];
  keySenders: { sender: string; latest: MailItem | null }[];
  digest: { summary: string; drafts: { id: string; to: string; subject: string; body: string }[] };
  meetings: { id: string; time: string; title: string; with: string }[];
}

export const GMAIL: GmailDashboard = {
  needsReply: [
    {
      id: "g1",
      from: "Tom Okafor",
      subject: "Contract redlines, round 2",
      snippet: "Attached the redlines. Can you confirm clause 7 works for you?",
      time: "9:12",
    },
    {
      id: "g2",
      from: "Aiko Tanaka",
      subject: "Intro: Ravi from Northwind",
      snippet: "Happy to connect you two. Ravi, meet Sam…",
      time: "8:40",
    },
  ],
  importantUnread: [
    {
      id: "g3",
      from: "Finance Team",
      subject: "Q3 budget review moved to Thursday",
      snippet: "Please bring the updated forecast.",
      time: "Yesterday",
    },
    {
      id: "g4",
      from: "Lena Fischer",
      subject: "Roadmap draft v3",
      snippet: "Here's the version with your comments folded in.",
      time: "Yesterday",
    },
  ],
  keySenders: [
    {
      sender: "Tom Okafor",
      latest: { id: "g1", from: "Tom Okafor", subject: "Contract redlines, round 2", snippet: "", time: "9:12" },
    },
    {
      sender: "Lena Fischer",
      latest: { id: "g4", from: "Lena Fischer", subject: "Roadmap draft v3", snippet: "", time: "Yesterday" },
    },
    { sender: "Board Office", latest: null },
  ],
  digest: {
    summary: "21 emails since yesterday: 2 need replies, 4 newsletters, 15 notifications. Two replies are drafted.",
    drafts: [
      {
        id: "gd1",
        to: "Aiko Tanaka",
        subject: "Re: Intro: Ravi from Northwind",
        body: "Thanks Aiko! Ravi, great to meet you. Would Tuesday at 11 work for a quick call?",
      },
      {
        id: "gd2",
        to: "Finance Team",
        subject: "Re: Q3 budget review moved to Thursday",
        body: "Thanks for the heads-up. I'll bring the updated forecast on Thursday.",
      },
    ],
  },
  meetings: [
    { id: "m1", time: "11:00", title: "Weekly product sync", with: "Lena, Marco, +3" },
    { id: "m2", time: "14:30", title: "Northwind intro call", with: "Ravi Menon" },
    { id: "m3", time: "16:00", title: "1:1", with: "Priya Shah" },
  ],
};

export const LINEAR_FEED: Feed = {
  summary: "2 issues assigned to you changed today.",
  items: [
    {
      id: "l1",
      title: "LAUNCH-42: Pricing page copy review",
      subtitle: "Due today",
      time: "1 h ago",
      needsYou: true,
      why: "Assigned to you and due today",
    },
    { id: "l2", title: "LAUNCH-37: Press kit assets", subtitle: "In progress", time: "3 h ago", needsYou: false },
    { id: "l3", title: "OPS-12: Offsite budget", subtitle: "Backlog", time: "Yesterday", needsYou: false },
  ],
};

/** Open pull requests per repository: the agent-made widget's data. */
export const OPEN_PRS: { repo: string; open: number; reviewing: number }[] = [
  { repo: "web", open: 6, reviewing: 2 },
  { repo: "api", open: 4, reviewing: 1 },
  { repo: "mobile", open: 3, reviewing: 0 },
  { repo: "docs", open: 2, reviewing: 1 },
];

/**
 * An agent-made widget: one self-contained HTML file, rendered in a sandboxed iframe. It
 * receives `init` (with the theme's tokens and a MessageChannel port) and then `data`, and only
 * renders. It has no network and no access to the app.
 */
export const AGENT_WIDGET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{font-family:system-ui,sans-serif;color:var(--rlx-foreground);background:transparent}
body{margin:0;padding:4px 2px;font-size:13px}
.row{display:grid;grid-template-columns:64px 1fr 28px;gap:8px;align-items:center;margin:6px 0}
.bar{height:10px;border-radius:5px;background:var(--rlx-panel);overflow:hidden;display:flex}
.open{background:var(--rlx-primary)}.rev{background:var(--rlx-accent)}
.legend{display:flex;gap:12px;color:var(--rlx-muted);font-size:12px;margin-top:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:4px}
.n{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><div id="chart">Waiting for data…</div>
<div class="legend"><span><span class="dot open"></span>Open</span><span><span class="dot rev"></span>In review</span></div>
<script>
var port=null;
function applyTheme(t){for(var k in t){document.documentElement.style.setProperty('--rlx-'+k,t[k]);}}
function render(rows){var max=1;rows.forEach(function(r){max=Math.max(max,r.open)});
var c=document.getElementById('chart');c.textContent='';
rows.forEach(function(r){var row=document.createElement('div');row.className='row';
var name=document.createElement('span');name.textContent=r.repo;
var bar=document.createElement('div');bar.className='bar';
var o=document.createElement('div');o.className='open';o.style.width=((r.open-r.reviewing)/max*100)+'%';
var v=document.createElement('div');v.className='rev';v.style.width=(r.reviewing/max*100)+'%';
bar.appendChild(o);bar.appendChild(v);var n=document.createElement('span');n.className='n';n.textContent=r.open;
row.appendChild(name);row.appendChild(bar);row.appendChild(n);c.appendChild(row);});}
function onMessage(m){if(!m||m.v!==1)return;if(m.type==='init'){applyTheme(m.theme||{});}
if(m.type==='theme'){applyTheme(m.theme||{});}if(m.type==='data'){render(m.data||[]);}}
window.addEventListener('message',function(e){var m=e.data;if(m&&m.type==='init'&&e.ports&&e.ports[0]){port=e.ports[0];
port.onmessage=function(ev){onMessage(ev.data)};onMessage(m);port.postMessage({type:'ready',v:1});}});
</script></body></html>`;

export const TASK_SCRIPTS: Record<string, string[]> = {
  "Weekly status report": [
    "Reading last week's #launch and #product threads…",
    "Found 23 relevant messages and 4 closed Linear issues.",
    "Grouping updates by workstream: Launch, Pricing, Hiring.",
    "Drafting the summary in your usual format.",
    "Checking the numbers against the Q3 tracker.",
    "Done: a 1-page report with 3 risks and 2 asks.",
  ],
  default: [
    "Understanding the request…",
    "Gathering context from your connectors.",
    "Working through the steps.",
    "Checking the result.",
    "Done.",
  ],
};

export const CHAT_REPLIES: string[] = [
  "On it. From Slack, the most urgent thing is Priya's sign-off on the pricing copy before 3pm.",
  "I've drafted a reply for you to review in Approvals. It ends with my sign-off.",
  "Your calendar has a gap at 13:00 to 14:00 if you want to block focus time.",
  "I can watch #launch and tell you when the press kit owner is decided. Want me to?",
];

export const FLEET: FleetAgent[] = [
  { id: "a1", label: "manager", role: "manager", project: "web", state: "waiting", account: "Account 1", task: "Plan the pricing page release" },
  { id: "a2", label: "coder-pricing", role: "coder", project: "web", state: "live", account: "Account 1", task: "Build the pricing table" },
  { id: "a3", label: "tester-pricing", role: "tester", project: "web", state: "live", account: "Account 2", task: "Verify the pricing table" },
  { id: "a4", label: "coder-api", role: "coder", project: "api", state: "paused", account: "Account 2", task: "Rate-limit the export endpoint" },
  { id: "a5", label: "reviewer", role: "reviewer", project: "api", state: "exited", account: "Account 1" },
];

export const BOARD: BoardTask[] = [
  { id: "t1", title: "Build the pricing table", status: "doing", owner: "coder-pricing" },
  { id: "t2", title: "Verify the pricing table", status: "doing", owner: "tester-pricing" },
  { id: "t3", title: "Rate-limit the export endpoint", status: "blocked", owner: "coder-api" },
  { id: "t4", title: "Review the auth refactor", status: "review", owner: "reviewer" },
  { id: "t5", title: "Write the launch checklist", status: "todo" },
  { id: "t6", title: "Fix the flaky signup test", status: "done", owner: "coder-api" },
];

export const PANE_LINES: Record<string, string[]> = {
  a2: [
    "> Build the pricing table",
    "● Reading src/pricing/Table.tsx",
    "● Editing src/pricing/Table.tsx (+42 −8)",
    "● Running npm test -- pricing",
    "  ✓ renders three plans (12 ms)",
    "  ✓ highlights the recommended plan (4 ms)",
    "● All 14 tests pass. Opening a PR.",
  ],
  a3: [
    "> Verify the pricing table",
    "● Waiting for coder-pricing's PR",
    "● Checking out pricing-table at 3f2a9c1",
    "● Running the visual checks at 1280×800 and 390×844",
  ],
  default: ["(no output yet)"],
};
