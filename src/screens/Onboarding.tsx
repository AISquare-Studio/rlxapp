import { useCallback, useEffect, useState } from "react";
import { RlxMark } from "../brand/RlxMark.tsx";
import { SignOff } from "../brand/SignOff.tsx";
import type { ClaudeMock } from "../engine/demo.ts";
import type { EngineStatus } from "../engine/types.ts";
import { useApp } from "../state/context.ts";

const STEPS = ["Welcome", "Claude Code", "Your agent", "Done"] as const;

export function Onboarding() {
  const { state, updateSettings, navigate } = useApp();
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState(state.settings.agentName);
  const [ownerName, setOwnerName] = useState(state.settings.ownerName);

  const finish = () => {
    updateSettings({ onboarded: true, agentName: agentName.trim() || "Nova", ownerName: ownerName.trim() || "you" });
    navigate({ name: "home" });
  };

  return (
    <div className="onboarding">
      <header className="onboarding__header">
        <RlxMark className="onboarding__mark" />
      </header>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "is-current" : i < step ? "is-done" : ""} aria-current={i === step ? "step" : undefined}>
            {label}
          </li>
        ))}
      </ol>
      <div className="onboarding__card">
        {step === 0 ? (
          <section aria-label="Welcome">
            <h1>Welcome to rlx</h1>
            <p>
              rlx runs an AI agent for you in the background. It watches Slack and Gmail, keeps your dashboard up to date, and
              drafts replies. Nothing is sent without your approval.
            </p>
            <div className="button-row">
              <button type="button" className="button button--primary" onClick={() => setStep(1)}>
                Get started
              </button>
            </div>
          </section>
        ) : null}
        {step === 1 ? <ClaudeStep onNext={() => setStep(2)} onBack={() => setStep(0)} /> : null}
        {step === 2 ? (
          <section aria-label="Name your agent">
            <h1>Name your agent</h1>
            <p className="muted">It signs everything it sends for you.</p>
            <label className="field">
              <span>Agent name</span>
              <input value={agentName} maxLength={32} onChange={(e) => setAgentName(e.target.value)} aria-label="Agent name" />
            </label>
            <label className="field">
              <span>Your name</span>
              <input value={ownerName} maxLength={64} onChange={(e) => setOwnerName(e.target.value)} aria-label="Your name" />
            </label>
            <div className="sign-off-preview" aria-label="Sign-off preview">
              <span className="muted">Every message ends with:</span>
              <SignOff agentName={agentName.trim()} ownerName={ownerName.trim()} />
            </div>
            <div className="button-row">
              <button type="button" className="button" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="button button--primary" disabled={!agentName.trim()} onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </section>
        ) : null}
        {step === 3 ? (
          <section aria-label="Done">
            <h1>{agentName.trim() || "Your agent"} is ready</h1>
            <p>
              Your dashboard has a Slack digest, Gmail, a clock and a pomodoro to start with. Add more from Home, or ask{" "}
              {agentName.trim() || "your agent"} to make one.
            </p>
            <div className="button-row">
              <button type="button" className="button" onClick={() => setStep(2)}>
                Back
              </button>
              <button type="button" className="button button--primary" onClick={finish}>
                Go to Home
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

const MOCK_LABEL: Record<ClaudeMock, string> = {
  "not-installed": "Not installed",
  "signed-out": "Signed out",
  "signed-in": "Signed in",
};

function ClaudeStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  // The mock state switch shows only with a fake engine's demo controls.
  const { engine, demo: mock } = useApp();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reread = useCallback(() => {
    void engine.status().then(setStatus);
  }, [engine]);

  useEffect(() => {
    reread();
  }, [reread]);
  const current: ClaudeMock = status?.kind === "ready" ? "signed-in" : status?.kind === "not-installed" ? "not-installed" : "signed-out";

  return (
    <section aria-label="Claude Code status">
      <h1>Claude Code</h1>
      <p className="muted">rlx uses Claude Code and your claude.ai plan. You sign in once; rlx never sees your password.</p>
      {mock ? (
        <fieldset className="segmented" aria-label="Mock Claude Code state">
          <legend className="muted">Mock state (preview only)</legend>
          {(Object.keys(MOCK_LABEL) as ClaudeMock[]).map((value) => (
            <label key={value} className={`segmented__option${current === value ? " is-active" : ""}`}>
              <input
                type="radio"
                name="claude-mock"
                value={value}
                checked={current === value}
                onChange={() => {
                  mock.setClaudeState(value);
                  reread();
                }}
              />
              {MOCK_LABEL[value]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className={`status-card status-card--${current}`} data-testid="claude-status">
        {status?.kind === "not-installed" ? (
          <>
            <strong>Claude Code isn't installed</strong>
            <p className="muted">rlx installs it for you.</p>
            <button
              type="button"
              className="button button--primary"
              disabled={busy !== null}
              onClick={() => {
                setBusy("Installing… 0%");
                void engine.install((pct) => setBusy(`Installing… ${pct}%`)).then(() => {
                  setBusy(null);
                  reread();
                });
              }}
            >
              {busy ?? "Install Claude Code"}
            </button>
          </>
        ) : null}
        {status?.kind === "signed-out" ? (
          <>
            <strong>Claude Code is installed, and you're signed out</strong>
            <p className="muted">Sign in with your claude.ai account in your browser.</p>
            <button
              type="button"
              className="button button--primary"
              disabled={busy !== null}
              onClick={() => {
                setBusy("Opening your browser…");
                void engine
                  .signIn((step) => {
                    if (step.kind === "waiting") setBusy("Waiting for you to finish in the browser…");
                    if (step.kind === "signed-in") setBusy(null);
                    if (step.kind === "error") setBusy(null);
                  })
                  .then(reread);
              }}
            >
              {busy ?? "Sign in with Claude"}
            </button>
          </>
        ) : null}
        {status?.kind === "ready" ? (
          <>
            <strong>Signed in</strong>
            <p className="muted">
              {status.account} · {status.plan} plan
            </p>
          </>
        ) : null}
      </div>
      <div className="button-row">
        <button type="button" className="button" onClick={onBack}>
          Back
        </button>
        <button type="button" className="button button--primary" disabled={status?.kind !== "ready"} onClick={onNext}>
          Continue
        </button>
      </div>
    </section>
  );
}
