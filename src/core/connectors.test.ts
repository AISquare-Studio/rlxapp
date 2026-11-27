import { describe, expect, it } from "vitest";
import { BRIEFING, CONNECTORS } from "../engine/fake/data.ts";
import { FakeEngine, parseInstruction } from "../engine/fake/FakeEngine.ts";
import { USER_CONNECTORS, seedAgents } from "../state/agents.ts";
import { CONNECTOR_NAMES, DEFAULT_SETTINGS } from "../state/model.ts";
import { GMAIL, GOOGLE_CALENDAR, GOOGLE_DRIVE, LINEAR, SLACK, connectorId, connectorLabel, isConnectorId } from "./connectors.ts";
import { FakeCore } from "./fake/FakeCore.ts";
import { sendCheck } from "./gate.ts";

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
const code = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

describe("connector ids: one spelling everywhere", () => {
  it("stores the claude.ai server name in agents, proposals, the briefing, send modes, widgets, the engine and the core's data", () => {
    const core = new FakeCore({ engine: new FakeEngine({ seed: false }), storage: null });
    const snap = core.snapshot();
    core.dispose();
    const stored: [string, string][] = [
      ...USER_CONNECTORS.map((c) => ["USER_CONNECTORS", c] as [string, string]),
      ...CONNECTOR_NAMES.map((c) => ["CONNECTOR_NAMES", c] as [string, string]),
      ...seedAgents(0).flatMap((a) => a.connectors.map((c) => [`agent ${a.id}`, c] as [string, string])),
      ...["every weekday at 9 a start of day briefing", "watch slack and gmail daily at 5pm", "linear bugs every hour", "google calendar at 8"].flatMap((text) =>
        parseInstruction(text).connectors.map((c) => [`proposal "${text}"`, c] as [string, string]),
      ),
      ["briefing draft", BRIEFING.draft.connector],
      ["briefing needs-context", BRIEFING.needsContext.connector],
      ...[...BRIEFING.doNow, ...BRIEFING.today, ...BRIEFING.waiting].flatMap((i) => i.sources.map((s) => [`briefing ${i.id}`, s.connector] as [string, string])),
      ...BRIEFING.promise.sources.map((s) => ["briefing promise", s.connector] as [string, string]),
      ...Object.keys(DEFAULT_SETTINGS.sendModes).map((c) => ["sendModes", c] as [string, string]),
      ...DEFAULT_SETTINGS.widgets.flatMap((w) => (w.connector ? [["widget", w.connector] as [string, string]] : [])),
      ...CONNECTORS.map((c) => ["engine connectors", c.id] as [string, string]),
      ...snap.drafts.map((d) => ["draft", d.connector] as [string, string]),
      ...snap.approvals.map((a) => ["approval", a.connector] as [string, string]),
      ...snap.activity.map((a) => ["activity", a.connector] as [string, string]),
    ];
    expect(stored.length).toBeGreaterThan(30);
    expect(stored.filter(([, id]) => !isConnectorId(id))).toEqual([]);
  });

  it("shows people the name, and reads any spelling back to the id", () => {
    expect(connectorLabel(SLACK)).toBe("Slack");
    expect(connectorLabel(GOOGLE_CALENDAR)).toBe("Google Calendar");
    expect(connectorLabel(GOOGLE_DRIVE)).toBe("Meet transcripts (Google Drive)");
    for (const id of [SLACK, GMAIL, LINEAR, GOOGLE_CALENDAR, GOOGLE_DRIVE]) {
      expect(connectorId(connectorLabel(id))).toBe(id);
      expect(connectorId(id)).toBe(id);
    }
    expect(connectorId("Slack")).toBe(SLACK);
  });

  it("lets an agent's draft find its connector's send mode (the 'Slack' vs 'claude.ai Slack' split is gone)", () => {
    const draft = { id: "d", status: "pending" as const, origin: "task" as const, connector: BRIEFING.draft.connector, destination: "Finance Team", body: "", createdAt: 0, context: "" };
    expect(sendCheck(draft, { sendModes: { [GMAIL]: "auto" } }, []).mode).toBe("auto");
    // An agent mounts the same ids a widget does.
    const gtm = seedAgents(0).find((a) => a.id === "gtm-agent");
    expect(gtm?.connectors).toEqual([SLACK, GMAIL]);
  });

  it("spells ids only through the constants, and labels only through connectorLabel", () => {
    const comment = /^\s*(\/\/|\*|\/\*)/;
    const literal = code.flatMap(([path, text]) =>
      path === "/src/core/connectors.ts"
        ? []
        : text
            .split("\n")
            .filter((line) => !comment.test(line) && /["'`]claude\.ai /.test(line))
            .map((line) => `${path}: ${line.trim()}`),
    );
    expect(literal).toEqual([]);
    const stripping = code.filter(([path, text]) => path !== "/src/core/connectors.ts" && /claude\\\.ai/.test(text)).map(([path]) => path);
    expect(stripping).toEqual([]);
  });
});
