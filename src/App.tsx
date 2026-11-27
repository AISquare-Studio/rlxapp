import { useEffect, useState } from "react";
import { Splash } from "./brand/Splash.tsx";
import type { Core } from "./core/types.ts";
import type { DemoControls } from "./engine/demo.ts";
import type { DeveloperEngine, Engine } from "./engine/types.ts";
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
import { useApp } from "./state/context.ts";
import { effectiveAccent, resolveTheme } from "./theme/themes.ts";
import { useOsDark } from "./theme/useOsDark.ts";
import "./App.css";

/**
 * The UI's seams, all interfaces: the composition root (main.tsx) chooses what implements them.
 * Until rlxd ships, those are fakes with mock data.
 */
export interface AppProps {
  platform: Platform;
  /** The app core: product state, the scheduler's follow-up, the send gate and storage. */
  core: Core;
  /** Agentic work: runs, Claude Code status, the rlx service's settings. */
  engine: Engine;
  /** Developer mode's reads: fleet, board, panes. */
  developer: DeveloperEngine;
  /** A fake engine's preview controls; absent with a real engine. */
  demo?: DemoControls;
}

export function App({ platform, core, engine, developer, demo }: AppProps) {
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
  return (
    <AppProvider core={core} engine={engine} developer={developer} platform={platform} demo={demo}>
      <Root measuring={boot.measuring} />
    </AppProvider>
  );
}

/** `measuring`: a budget measurement opens on Home, past onboarding, and changes nothing (scripts/measure-budgets.sh). */
function Root({ measuring }: { measuring: boolean }) {
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

  if (!onboarded && !measuring) return <Onboarding />;

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
