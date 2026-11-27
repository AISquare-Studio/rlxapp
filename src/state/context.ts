import { createContext, useContext } from "react";
import type { Core } from "../core/types.ts";
import type { DemoControls } from "../engine/demo.ts";
import type { DeveloperEngine, Engine } from "../engine/types.ts";
import type { Platform } from "../platform/index.ts";
import type { Action } from "./reducer.ts";
import type { AppState, Screen, Settings, Toast } from "./model.ts";

export type { DemoControls } from "../engine/demo.ts";

export interface AppContextValue {
  /** The core's snapshot plus this window's navigation, toasts and About box. */
  state: AppState;
  screen: Screen;
  /** The window's own actions (navigation, toasts, About); product changes go through `core`. */
  dispatch: (action: Action) => void;
  core: Core;
  engine: Engine;
  developer: DeveloperEngine;
  platform: Platform;
  navigate: (screen: Screen) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  signOff: string;
  now: () => number;
  /** A fake engine's preview controls; absent with a real engine. */
  demo?: DemoControls;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside <AppProvider>");
  return value;
}
