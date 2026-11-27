/** The window's own state: navigation history, toasts and the About box. Product state is the core's. */
import type { Screen, Toast, UiState } from "./model.ts";

export type Action =
  | { type: "navigate"; screen: Screen }
  | { type: "back" }
  | { type: "forward" }
  | { type: "toast"; toast: Toast }
  | { type: "toast-dismiss"; id: string }
  | { type: "about"; open: boolean };

function sameScreen(a: Screen | undefined, b: Screen): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "navigate": {
      if (sameScreen(state.history[state.index], action.screen)) return state;
      const history = [...state.history.slice(0, state.index + 1), action.screen].slice(-50);
      return { ...state, history, index: history.length - 1 };
    }
    case "back":
      return state.index > 0 ? { ...state, index: state.index - 1 } : state;
    case "forward":
      return state.index < state.history.length - 1 ? { ...state, index: state.index + 1 } : state;
    case "toast":
      return { ...state, toasts: [...state.toasts, action.toast].slice(-3) };
    case "toast-dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "about":
      return { ...state, aboutOpen: action.open };
  }
}

export function initialUiState(): UiState {
  return { history: [{ name: "home" }], index: 0, toasts: [], aboutOpen: false };
}
