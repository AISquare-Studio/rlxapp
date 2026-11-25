import { USER_CONNECTORS, type AgentOutput, type Schedule } from "../state/agents.ts";
import type { Proposal } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";

const OUTPUTS: { id: AgentOutput; label: string }[] = [
  { id: "channel", label: "Channel message" },
  { id: "widget", label: "Widget" },
  { id: "dashboard", label: "Home dashboard section" },
];

/** Edits an agent's setup: name, connectors (chips, never a fixed list), schedule, silent/loud and output. */
export function AgentEditor({ value, onChange, idPrefix }: { value: Proposal; onChange: (next: Proposal) => void; idPrefix: string }) {
  const set = (patch: Partial<Proposal>) => onChange({ ...value, ...patch });
  const setSchedule = (patch: Partial<Schedule>) => set({ schedule: { ...value.schedule, ...patch } });
  const available = USER_CONNECTORS.filter((c) => !value.connectors.includes(c));
  return (
    <div className="agent-editor">
      <label className="field">
        <span>Name</span>
        <input value={value.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} aria-label="Agent name" />
      </label>
      <fieldset className="field-group">
        <legend>Connectors</legend>
        <ul className="connector-chips" aria-label="Connectors">
          {value.connectors.map((c) => (
            <li key={c} className="connector-chip">
              {c}
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${c}`}
                onClick={() => set({ connectors: value.connectors.filter((x) => x !== c) })}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
        {available.length ? (
          <label className="field field--inline">
            <span>Add</span>
            <select
              value=""
              aria-label="Add a connector"
              onChange={(e) => e.target.value && set({ connectors: [...value.connectors, e.target.value] })}
            >
              <option value="">Choose a connector…</option>
              {available.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>
      <fieldset className="field-group">
        <legend>Schedule</legend>
        <div className="inline-fields">
          <select
            value={value.schedule.kind}
            aria-label="Schedule"
            onChange={(e) => setSchedule({ kind: e.target.value as Schedule["kind"] })}
          >
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
            <option value="interval">Every few minutes</option>
          </select>
          {value.schedule.kind === "interval" ? (
            <label className="field field--inline">
              <span>Every</span>
              <input
                type="number"
                min={5}
                max={240}
                value={value.schedule.everyMin ?? 15}
                onChange={(e) => setSchedule({ everyMin: Number(e.target.value) || 15 })}
                aria-label="Minutes between runs"
              />
              <span>min</span>
            </label>
          ) : (
            <label className="field field--inline">
              <span>at</span>
              <input type="time" value={value.schedule.at ?? "09:00"} onChange={(e) => setSchedule({ at: e.target.value })} aria-label="Time" />
            </label>
          )}
        </div>
      </fieldset>
      <fieldset className="field-group">
        <legend>When it runs</legend>
        <div className="segmented">
          {(["silent", "loud"] as const).map((mode) => (
            <label key={mode} className={`segmented__option${value.mode === mode ? " is-active" : ""}`}>
              <input type="radio" name={`${idPrefix}-mode`} checked={value.mode === mode} onChange={() => set({ mode })} />
              {mode === "silent" ? "Silent: update widgets only" : "Loud: notify and post"}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field-group">
        <legend>Output</legend>
        {OUTPUTS.map((o) => (
          <label key={o.id} className="check">
            <input
              type="checkbox"
              checked={value.outputs.includes(o.id)}
              onChange={(e) => set({ outputs: e.target.checked ? [...value.outputs, o.id] : value.outputs.filter((x) => x !== o.id) })}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
