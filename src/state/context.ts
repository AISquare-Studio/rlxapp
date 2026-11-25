import { createContext, useContext } from "react";
import type { DeveloperEngine, Engine } from "../engine/types.ts";
import type { Platform } from "../platform/index.ts";
import type { Action } from "./reducer.ts";
import type { AppState, Screen, Settings, Toast } from "./model.ts";

/** Demo controls the FakeEngine offers; absent on a real engine. */
export interface DemoControls {
  /** Makes the next Slack fetch find new messages, so it takes a model turn. */
  simulateNewSlack(count?: number): void;
}

export interface AppContextValue {
  state: AppState;
  screen: Screen;
  dispatch: (action: Action) => void;
  engine: Engine;
  developer: DeveloperEngine;
  platform: Platform;
  navigate: (screen: Screen) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  signOff: string;
  now: () => number;
  demo?: DemoControls;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside <AppProvider>");
  return value;
}
