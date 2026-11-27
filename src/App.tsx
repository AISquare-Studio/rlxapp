import { useEffect, useMemo, useState } from "react";
import { Splash } from "./brand/Splash.tsx";
import { FakeEngine } from "./engine/fake/FakeEngine.ts";
import type { Platform } from "./platform/index.ts";
import { Agents } from "./screens/Agents.tsx";
import { Approvals } from "./screens/Approvals.tsx";
import { Channel } from "./screens/Channel.tsx";
import { Board, Fleet, Panes } from "./screens/Developer.tsx";
import { Home } from "./screens/Home.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { Runs } from "./screens/Runs.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Shell } from "./shell/Shell.tsx";
import { AppProvider } from "./state/AppProvider.tsx";
import { loadSettings } from "./state/reducer.ts";
import { useApp } from "./state/context.ts";
import type { Settings as AppSettings } from "./state/model.ts";
import { effectiveAccent, resolveTheme } from "./theme/themes.ts";
import { useOsDark } from "./theme/useOsDark.ts";
import "./App.css";

export interface AppProps {
  platform: Platform;
  /** The engine to drive the UI; defaults to a FakeEngine with mock data. */
  engine?: FakeEngine;
  initialSettings?: AppSettings;
}

export function App({ platform, engine: given, initialSettings }: AppProps) {
  const engine = useMemo(() => given ?? new FakeEngine(), [given]);
  const demo = useMemo(() => ({ simulateNewSlack: (count?: number) => engine.simulateNewSlack(count) }), [engine]);
  const [boot, setBoot] = useState<{ measuring: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([engine.hello(), platform.appInfo().catch(() => null)])
      .then(([, info]) => active && setBoot({ measuring: info?.measuring ?? false }))
      .catch((error: unknown) => console.error("engine hello failed", error));
    return () => {
      active = false;
    };
  }, [engine, platform]);

  if (!boot) return <Splash />;
  // A budget measurement opens on Home and saves nothing (scripts/measure-budgets.sh).
  const settings = boot.measuring ? { ...(initialSettings ?? loadSettings()), onboarded: true } : initialSettings;
  return (
    <AppProvider engine={engine} developer={engine} platform={platform} initialSettings={settings} demo={demo} persist={!boot.measuring}>
      <Root engine={engine} />
    </AppProvider>
  );
}

function Root({ engine }: { engine: FakeEngine }) {
  const { state, screen, navigate } = useApp();
  const osDark = useOsDark();
  const { family, mode, accent, density, devMode, onboarded } = state.settings;
  const theme = resolveTheme(family, mode, osDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.name;
    root.dataset.density = density;
    root.style.setProperty("--rlx-accent", effectiveAccent(theme, accent));
    root.style.colorScheme = theme.dark ? "dark" : "light";
  }, [theme, accent, density]);

  const devScreen = screen.name === "runs" || screen.name === "fleet" || screen.name === "board" || screen.name === "panes";
  useEffect(() => {
    if (devScreen && !devMode) navigate({ name: "home" });
  }, [devScreen, devMode, navigate]);

  if (!onboarded) {
    return (
      <Onboarding
        claudeMock={{
          get: () => engine.claudeState(),
          set: (s) => engine.setClaudeState(s),
          install: (onProgress) => engine.install(onProgress),
        }}
      />
    );
  }

  return (
    <Shell>
      {screen.name === "home" ? <Home /> : null}
      {screen.name === "agents" ? <Agents /> : null}
      {screen.name === "channel" ? <Channel key={screen.id} id={screen.id} /> : null}
      {screen.name === "approvals" ? <Approvals /> : null}
      {devMode && screen.name === "runs" ? <Runs /> : null}
      {screen.name === "settings" ? <Settings osDark={osDark} /> : null}
      {devMode && screen.name === "fleet" ? <Fleet /> : null}
      {devMode && screen.name === "board" ? <Board /> : null}
      {devMode && screen.name === "panes" ? <Panes /> : null}
    </Shell>
  );
}
