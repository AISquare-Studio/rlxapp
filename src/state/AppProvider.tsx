import { useCallback, useLayoutEffect, useMemo, useReducer, useSyncExternalStore, type ReactNode } from "react";
import type { Core, SettingsPatch, Surface } from "../core/types.ts";
import type { DemoControls } from "../engine/demo.ts";
import type { DeveloperEngine, Engine } from "../engine/types.ts";
import type { Platform } from "../platform/index.ts";
import { AppContext, type AppContextValue } from "./context.ts";
import { signOffText, type Screen, type Toast } from "./model.ts";
import { initialUiState, reducer } from "./reducer.ts";

export interface AppProviderProps {
  core: Core;
  engine: Engine;
  developer: DeveloperEngine;
  platform: Platform;
  now?: () => number;
  demo?: DemoControls;
  children: ReactNode;
}

let toastCounter = 0;

/** What a screen shows, for the core's unread counts. */
function surfaceOf(screen: Screen): Surface | null {
  return screen.name === "channel" ? { kind: "channel", id: screen.id } : null;
}

export function AppProvider({ core, engine, developer, platform, now = Date.now, demo, children }: AppProviderProps) {
  const snapshot = useSyncExternalStore(core.subscribe, core.snapshot);
  const [ui, dispatch] = useReducer(reducer, undefined, initialUiState);
  const screen = useMemo<Screen>(() => ui.history[ui.index] ?? { name: "home" }, [ui.history, ui.index]);
  const surface = JSON.stringify(surfaceOf(screen));

  // Before paint, so opening a channel never flashes its unread dot.
  useLayoutEffect(() => {
    core.view(JSON.parse(surface) as Surface | null);
  }, [core, surface]);
  useLayoutEffect(() => () => core.view(null), [core]);

  const navigate = useCallback((next: Screen) => dispatch({ type: "navigate", screen: next }), []);
  const updateSettings = useCallback((patch: SettingsPatch) => void core.updateSettings(patch), [core]);
  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    dispatch({ type: "toast", toast: { id, text, tone } });
    setTimeout(() => dispatch({ type: "toast-dismiss", id }), 4500);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      state: { ...snapshot, ...ui },
      screen,
      dispatch,
      core,
      engine,
      developer,
      platform,
      navigate,
      updateSettings,
      toast,
      signOff: signOffText(snapshot.settings.agentName, snapshot.settings.ownerName),
      now,
      demo,
    }),
    [snapshot, ui, screen, core, engine, developer, platform, navigate, updateSettings, toast, now, demo],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
