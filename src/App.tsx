import { useEffect, useMemo, useState } from "react";
import { Splash } from "./brand/Splash.tsx";
import { FakeEngine } from "./engine/fake/FakeEngine.ts";
import type { Platform } from "./platform/index.ts";
import { Approvals } from "./screens/Approvals.tsx";
import { Chat } from "./screens/Chat.tsx";
import { Board, Fleet, Panes } from "./screens/Developer.tsx";
import { Home } from "./screens/Home.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Tasks } from "./screens/Tasks.tsx";
import { Shell } from "./shell/Shell.tsx";
import { AppProvider } from "./state/AppProvider.tsx";
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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    engine
      .hello()
      .then(() => active && setReady(true))
      .catch((error: unknown) => console.error("engine hello failed", error));
    return () => {
      active = false;
    };
  }, [engine]);

  if (!ready) return <Splash />;
  return (
    <AppProvider engine={engine} developer={engine} platform={platform} initialSettings={initialSettings}>
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

  const devScreen = screen.name === "fleet" || screen.name === "board" || screen.name === "panes";
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
      {screen.name === "tasks" ? <Tasks /> : null}
      {screen.name === "approvals" ? <Approvals /> : null}
      {screen.name === "chat" ? <Chat /> : null}
      {screen.name === "settings" ? <Settings osDark={osDark} /> : null}
      {devMode && screen.name === "fleet" ? <Fleet /> : null}
      {devMode && screen.name === "board" ? <Board /> : null}
      {devMode && screen.name === "panes" ? <Panes /> : null}
    </Shell>
  );
}
