/**
 * Device-local settings: the only app state kept in this device's storage (localStorage).
 * Everything else lives with the host and comes through the core.
 *
 * `DeviceStore` is the single writer of that storage key. The composition root makes one per
 * window and hands it to whatever needs it: the core today, sessions (switching hosts) next, so
 * the device's settings exist before any core does and outlive a host switch.
 */
import type { Unsubscribe } from "../engine/types.ts";
import { connectorId } from "./connectors.ts";
import { pickHost, type HostData, type HostStore } from "./host.ts";
import { jobIdFor, type Agent } from "../state/agents.ts";
import { DEVICE_SETTING_KEYS, type AppSettings, type DeviceSettings, type WidgetInstance } from "../state/model.ts";

export const DEVICE_STORAGE_KEY = "rlx.device.v1";

/** Before the core seam, the app kept every setting here, agents included. Migrated once, then removed. */
export const LEGACY_SETTINGS_KEY = "rlx.settings.v1";

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { onboarded: false, devMode: false, engineHome: "" };

export type DeviceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This device's localStorage, or null where there is none (or reading it throws). */
export function deviceStorage(): DeviceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Only the device keys, whatever else is in `value`. */
export function pickDevice(value: Partial<Record<string, unknown>>): Partial<DeviceSettings> {
  const out: Partial<Record<string, unknown>> = {};
  for (const key of DEVICE_SETTING_KEYS) if (key in value) out[key] = value[key];
  return out as Partial<DeviceSettings>;
}

function read(storage: DeviceStorage | null, key: string): Record<string, unknown> | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class DeviceStore {
  private settings: DeviceSettings;
  private stored: boolean;
  private readonly storage: DeviceStorage | null;
  private readonly listeners = new Set<(settings: DeviceSettings) => void>();

  /** `seed` overrides what's stored for this window only (tests); it isn't written. */
  constructor(storage: DeviceStorage | null, seed: Partial<DeviceSettings> = {}) {
    this.storage = storage;
    const saved = read(storage, DEVICE_STORAGE_KEY);
    this.stored = saved !== null;
    this.settings = { ...DEFAULT_DEVICE_SETTINGS, ...pickDevice(saved ?? {}), ...pickDevice(seed) };
  }

  get(): DeviceSettings {
    return this.settings;
  }

  /** Whether this device has saved its settings yet. */
  hasStored(): boolean {
    return this.stored;
  }

  /** Changes some settings; returns whether they reached this device's storage. */
  update(patch: Partial<DeviceSettings>): boolean {
    this.settings = { ...this.settings, ...pickDevice(patch) };
    let saved = false;
    try {
      this.storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(this.settings));
      saved = this.storage !== null;
      this.stored ||= saved;
    } catch {
      // Storage can be unavailable (private mode); device settings then last for the session.
    }
    for (const listener of this.listeners) listener(this.settings);
    return saved;
  }

  subscribe(listener: (settings: DeviceSettings) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** A pre-seam agent: no job id yet, and its connectors named as people say them ("Slack"). */
function migrateAgent(agent: Agent): Agent {
  return { ...agent, jobId: agent.jobId || jobIdFor(agent.id), connectors: (agent.connectors ?? []).map(connectorId) };
}

/** Pre-seam host settings, with every connector spelled as an id. */
function migrateHostSettings(legacy: Record<string, unknown>): Partial<AppSettings> {
  const settings = pickHost(legacy);
  if (settings.sendModes) settings.sendModes = Object.fromEntries(Object.entries(settings.sendModes).map(([connector, mode]) => [connectorId(connector), mode]));
  if (Array.isArray(settings.widgets)) {
    settings.widgets = settings.widgets.map((w: WidgetInstance) => (w.connector ? { ...w, connector: connectorId(w.connector) } : w));
  }
  return settings;
}

/** rc's host data, as the host keeps it: connectors spelled as ids, marked as migrated. Null without the old key. */
export function legacyHostData(storage: DeviceStorage | null): HostData | null {
  const legacy = read(storage, LEGACY_SETTINGS_KEY);
  if (!legacy) return null;
  const agents = Array.isArray(legacy.agents) ? (legacy.agents as Agent[]).map(migrateAgent) : [];
  return { settings: migrateHostSettings(legacy), agents, migratedFrom: LEGACY_SETTINGS_KEY };
}

/** Whether rc's old key is still waiting to be migrated. */
export function legacyPending(storage: DeviceStorage | null): boolean {
  return read(storage, LEGACY_SETTINGS_KEY) !== null;
}

/**
 * Moves the pre-seam settings (rc's `rlx.settings.v1`) once: the host keys (names, theme, send
 * modes, widgets, agents) into the host's store, with connectors spelled as ids and the
 * `migratedFrom` marker, then the device keys into this device's store.
 *
 * - Host first: until the host's write reads back with its marker, nothing else changes, so a
 *   failed attempt leaves everything for the next launch to retry.
 * - A host blob without the marker is not the owner's data (a core wrote defaults before rc's
 *   data arrived), so rc's data replaces it. A device that already stored its settings keeps them.
 * - The old key goes only once both stores hold their part.
 *
 * Returns whether the old key was moved and removed.
 */
export function migrateLegacySettings(storage: DeviceStorage | null, device: DeviceStore, host: HostStore): boolean {
  const data = legacyHostData(storage);
  if (!storage || !data) return false;
  if (host.load()?.migratedFrom !== LEGACY_SETTINGS_KEY) {
    host.save(data);
    if (host.load()?.migratedFrom !== LEGACY_SETTINGS_KEY) return false;
  }
  const legacy = read(storage, LEGACY_SETTINGS_KEY) ?? {};
  if (!device.hasStored() && !(device.update(pickDevice(legacy)) && read(storage, DEVICE_STORAGE_KEY) !== null)) return false;
  try {
    storage.removeItem(LEGACY_SETTINGS_KEY);
  } catch {
    return false;
  }
  return true;
}
