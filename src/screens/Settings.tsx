import { useState } from "react";
import { SignOff } from "../brand/SignOff.tsx";
import { SANDBOX_HOME, engineHome, homeProblem } from "../engine/adapter/home.ts";
import { useApp } from "../state/context.ts";
import { CONNECTOR_NAMES, type Density, type SendMode, type ThemeMode } from "../state/model.ts";
import { ACCENT_PRESETS, FAMILIES, fitAccent, resolveTheme, type ThemeFamily } from "../theme/themes.ts";
import { Modal } from "../ui/Modal.tsx";

const MODES: { id: SendMode; label: string; help: string }[] = [
  { id: "draft", label: "Draft", help: "You approve every send (default)" },
  { id: "preapproved", label: "Pre-approved", help: "Standing approvals you confirmed send on their own; anything else is a draft" },
  { id: "auto", label: "Auto", help: "Sends after a 10-second hold with Undo. Risky" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "spacious", label: "Spacious" },
  { id: "default", label: "Default" },
  { id: "compact", label: "Compact" },
];

const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "Match system" },
];

export function Settings({ osDark }: { osDark: boolean }) {
  const { state, updateSettings, dispatch, navigate } = useApp();
  const s = state.settings;
  const [autoFor, setAutoFor] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [customHex, setCustomHex] = useState(s.accent.kind === "custom" ? s.accent.hex : "#E040FB");
  const theme = resolveTheme(s.family, s.mode, osDark);

  const setMode = (connector: string, mode: SendMode) => {
    if (mode === "auto") {
      setAutoFor(connector);
      setTyped("");
      return;
    }
    updateSettings({ sendModes: { ...s.sendModes, [connector]: mode } });
  };

  return (
    <div className="settings">
      <div className="screen-header">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      <section className="settings__section" id="send-safety" aria-labelledby="send-safety-title">
        <h2 id="send-safety-title">Send safety</h2>
        <p className="muted">How {s.agentName} may send on your behalf, per connector.</p>
        {CONNECTOR_NAMES.map((connector) => {
          const current = s.sendModes[connector] ?? "draft";
          const name = connector.replace(/^claude\.ai /, "");
          return (
            <fieldset key={connector} className="send-mode">
              <legend>{name}</legend>
              <div className="segmented">
                {MODES.map((mode) => (
                  <label key={mode.id} className={`segmented__option${current === mode.id ? " is-active" : ""}${mode.id === "auto" ? " segmented__option--risk" : ""}`}>
                    <input
                      type="radio"
                      name={`send-${connector}`}
                      value={mode.id}
                      checked={current === mode.id}
                      onChange={() => setMode(connector, mode.id)}
                      aria-describedby={`help-${connector}-${mode.id}`}
                    />
                    {mode.label}
                  </label>
                ))}
              </div>
              <p className="muted" id={`help-${connector}-${current}`}>
                {MODES.find((m) => m.id === current)?.help}
              </p>
              {current === "auto" ? <p className="warning-text">Auto is on: messages to {name} send after a 10-second hold.</p> : null}
            </fieldset>
          );
        })}
      </section>

      <section className="settings__section" id="appearance" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance</h2>
        <fieldset className="field-group">
          <legend>Theme</legend>
          <div className="theme-grid">
            {FAMILIES.map((f) => (
              <label key={f.family} className={`theme-card${s.family === f.family ? " is-active" : ""}`}>
                <input type="radio" name="theme-family" value={f.family} checked={s.family === f.family} onChange={() => updateSettings({ family: f.family as ThemeFamily })} />
                <span className="theme-card__swatches" data-theme={resolveTheme(f.family, s.mode, osDark).name} aria-hidden="true">
                  <span style={{ background: "var(--rlx-background)" }} />
                  <span style={{ background: "var(--rlx-panel)" }} />
                  <span style={{ background: "var(--rlx-primary)" }} />
                  <span style={{ background: "var(--rlx-accent)" }} />
                </span>
                {f.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field-group">
          <legend>Mode</legend>
          <div className="segmented">
            {THEME_MODES.map((m) => (
              <label key={m.id} className={`segmented__option${s.mode === m.id ? " is-active" : ""}`}>
                <input type="radio" name="theme-mode" value={m.id} checked={s.mode === m.id} onChange={() => updateSettings({ mode: m.id })} />
                {m.label}
              </label>
            ))}
          </div>
          <p className="muted">Showing {theme.label}.</p>
        </fieldset>
        <fieldset className="field-group">
          <legend>Accent</legend>
          <div className="segmented segmented--wrap">
            <label className={`segmented__option${s.accent.kind === "theme" ? " is-active" : ""}`}>
              <input type="radio" name="accent" checked={s.accent.kind === "theme"} onChange={() => updateSettings({ accent: { kind: "theme" } })} />
              Theme default
            </label>
            {ACCENT_PRESETS.map((p) => (
              <label key={p.id} className={`segmented__option${s.accent.kind === "preset" && s.accent.id === p.id ? " is-active" : ""}`}>
                <input type="radio" name="accent" checked={s.accent.kind === "preset" && s.accent.id === p.id} onChange={() => updateSettings({ accent: { kind: "preset", id: p.id } })} />
                <span className="swatch" style={{ background: theme.dark ? p.dark : p.light }} aria-hidden="true" />
                {p.label}
              </label>
            ))}
            <label className={`segmented__option${s.accent.kind === "custom" ? " is-active" : ""}`}>
              <input type="radio" name="accent" checked={s.accent.kind === "custom"} onChange={() => updateSettings({ accent: { kind: "custom", hex: customHex.toUpperCase() } })} />
              Custom
            </label>
          </div>
          <label className="field field--inline">
            <span>Custom colour</span>
            <input
              type="color"
              value={customHex}
              aria-label="Custom accent colour"
              onChange={(e) => {
                setCustomHex(e.target.value);
                updateSettings({ accent: { kind: "custom", hex: e.target.value.toUpperCase() } });
              }}
            />
            {s.accent.kind === "custom" ? (
              <span className="muted" data-testid="fitted-accent">
                Shown as {fitAccent(theme, s.accent.hex)} so text stays readable
              </span>
            ) : null}
          </label>
        </fieldset>
        <fieldset className="field-group">
          <legend>Density</legend>
          <div className="segmented">
            {DENSITIES.map((d) => (
              <label key={d.id} className={`segmented__option${s.density === d.id ? " is-active" : ""}`}>
                <input type="radio" name="density" value={d.id} checked={s.density === d.id} onChange={() => updateSettings({ density: d.id })} />
                {d.label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="settings__section" id="agent" aria-labelledby="agent-title">
        <h2 id="agent-title">Your agent</h2>
        <label className="field">
          <span>Agent name</span>
          <input value={s.agentName} maxLength={32} onChange={(e) => updateSettings({ agentName: e.target.value })} />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={s.ownerName} maxLength={64} onChange={(e) => updateSettings({ ownerName: e.target.value })} />
        </label>
        <p>
          <span className="muted">Sign-off: </span>
          <SignOff agentName={s.agentName} ownerName={s.ownerName} />
        </p>
      </section>

      <section className="settings__section" id="developer" aria-labelledby="developer-title">
        <h2 id="developer-title">Developer</h2>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={s.devMode}
            onChange={(e) => {
              updateSettings({ devMode: e.target.checked });
            }}
          />
          <span className="switch__track" aria-hidden="true" />
          Developer mode: show raw runs and logs, and Fleet, Board and Panes for your rlx projects
        </label>
        <EngineHomeField />
      </section>

      <section className="settings__section" id="about" aria-labelledby="about-title">
        <h2 id="about-title">About</h2>
        <div className="button-row">
          <button type="button" className="button" onClick={() => dispatch({ type: "about", open: true })}>
            About rlx
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              updateSettings({ onboarded: false });
              navigate({ name: "home" });
            }}
          >
            Run setup again
          </button>
        </div>
      </section>

      {autoFor ? (
        <Modal
          title={`Turn on Auto for ${autoFor.replace(/^claude\.ai /, "")}?`}
          tone="warning"
          onClose={() => setAutoFor(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setAutoFor(null)}>
                Keep drafts
              </button>
              <button
                type="button"
                className="button button--warning"
                disabled={typed.trim().toUpperCase() !== "AUTO"}
                onClick={() => {
                  updateSettings({ sendModes: { ...s.sendModes, [autoFor]: "auto" } });
                  setAutoFor(null);
                }}
              >
                Turn on Auto
              </button>
            </>
          }
        >
          <div className="risk" role="alert">
            <strong>This is risky.</strong>
            <ul>
              <li>{s.agentName} will send messages without asking you first, after a 10-second hold you can undo.</li>
              <li>Text in messages {s.agentName} reads could trick it into sending to anyone this connector can reach.</li>
              <li>Sends are limited to 10 an hour and every one is logged in Activity.</li>
            </ul>
          </div>
          <label className="field">
            <span>Type AUTO to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type AUTO to confirm" />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

function EngineHomeField() {
  const { state, updateSettings } = useApp();
  const [value, setValue] = useState(state.settings.engineHome);
  const problem = homeProblem(value);
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) updateSettings({ engineHome: value.trim() });
      }}
    >
      <label htmlFor="engine-home">Engine home (rlx's AISQUARE_HOME)</label>
      <div className="composer">
        <input
          id="engine-home"
          value={value}
          placeholder={SANDBOX_HOME}
          aria-invalid={problem ? true : undefined}
          aria-describedby="engine-home-help"
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="button" disabled={Boolean(problem) || value.trim() === state.settings.engineHome}>
          Save
        </button>
      </div>
      <span id="engine-home-help" className={problem ? "error-text" : "muted"} data-testid="engine-home-help">
        {problem ?? `Using ${engineHome(state.settings.engineHome)}. The app never reads or writes your real rlx home.`}
      </span>
    </form>
  );
}
