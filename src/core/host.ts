/**
 * The host's store: where the core keeps the host's app settings and agent definitions. The
 * real core reads and writes them through rlxd's settings API; fakes inject a store (memory in
 * tests, the browser's storage under its own key in the preview: ./fake/hostStore.ts).
 */
import { DEFAULT_SETTINGS, DEVICE_SETTING_KEYS, type AppSettings, type Settings } from "../state/model.ts";
import type { Agent } from "../state/agents.ts";

export interface HostData {
  settings: Partial<AppSettings>;
  agents: Agent[];
  /**
   * Set by the migration from rc's single settings key: this blob holds the owner's own data.
   * Until it's set, while that key exists, the blob is only what a core wrote before rc's data
   * arrived (defaults, demo agents), and rc's data replaces it.
   */
  migratedFrom?: string;
}

export interface HostStore {
  load(): HostData | null;
  save(data: HostData): void;
}

export class MemoryHostStore implements HostStore {
  private data: HostData | null;

  constructor(initial: HostData | null = null) {
    this.data = initial ? structuredClone(initial) : null;
  }

  load(): HostData | null {
    return this.data ? structuredClone(this.data) : null;
  }

  save(data: HostData): void {
    this.data = structuredClone(data);
  }
}

/** The host's part of a settings object: every app setting in it, and nothing else. */
export function pickHost(value: Partial<Settings> | Record<string, unknown>): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if ((DEVICE_SETTING_KEYS as readonly string[]).includes(key) || !(key in value)) continue;
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out as Partial<AppSettings>;
}

export const DEFAULT_APP_SETTINGS = pickHost(DEFAULT_SETTINGS) as AppSettings;
