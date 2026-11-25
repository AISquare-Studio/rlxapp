import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type { DeveloperEngine, Engine } from "../engine/types.ts";
import type { Platform } from "../platform/index.ts";
import { AppContext, type AppContextValue } from "./context.ts";
import { signOffText, type Screen, type Settings, type Toast } from "./model.ts";
import { STORAGE_KEY, initialState, loadSettings, reducer } from "./reducer.ts";

export interface AppProviderProps {
  engine: Engine;
  developer: DeveloperEngine;
  platform: Platform;
  initialSettings?: Settings;
  now?: () => number;
  children: ReactNode;
}

let toastCounter = 0;

export function AppProvider({ engine, developer, platform, initialSettings, now = Date.now, children }: AppProviderProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(initialSettings ?? loadSettings(), now()));

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch {
      // Storage can be unavailable (private mode); settings then last for the session.
    }
  }, [state.settings]);

  const navigate = useCallback((screen: Screen) => dispatch({ type: "navigate", screen }), []);
  const updateSettings = useCallback((patch: Partial<Settings>) => dispatch({ type: "settings", patch }), []);
  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    dispatch({ type: "toast", toast: { id, text, tone } });
    setTimeout(() => dispatch({ type: "toast-dismiss", id }), 4500);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      screen: state.history[state.index] ?? { name: "home" },
      dispatch,
      engine,
      developer,
      platform,
      navigate,
      updateSettings,
      toast,
      signOff: signOffText(state.settings.agentName, state.settings.ownerName),
      now,
    }),
    [state, engine, developer, platform, navigate, updateSettings, toast, now],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

