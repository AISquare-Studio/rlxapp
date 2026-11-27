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
import { pickHost, type HostStore } from "./host.ts";
import { jobIdFor, type Agent } from "../state/agents.ts";
import { DEVICE_SETTING_KEYS, type DeviceSettings } from "../state/model.ts";

export const DEVICE_STORAGE_KEY = "rlx.device.v1";

/** Before the core seam, the app kept every setting here, agents included. Read once, never written. */
export const LEGACY_SETTINGS_KEY = "rlx.settings.v1";

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { onboarded: false, devMode: false, engineHome: "" };

export type DeviceStorage = Pick<Storage, "getItem" | "setItem">;

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

  update(patch: Partial<DeviceSettings>): void {
    this.settings = { ...this.settings, ...pickDevice(patch) };
    try {
      this.storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(this.settings));
      this.stored = this.storage !== null;
    } catch {
      // Storage can be unavailable (private mode); device settings then last for the session.
    }
    for (const listener of this.listeners) listener(this.settings);
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

/**
 * Moves the pre-seam settings into the device store and the host store, once: only on a device
 * that hasn't stored its own settings yet, and never over host data already there. The old key
 * is left as it was. Returns whether it migrated.
 */
export function migrateLegacySettings(storage: DeviceStorage | null, device: DeviceStore, host: HostStore): boolean {
  const legacy = read(storage, LEGACY_SETTINGS_KEY);
  if (!legacy || device.hasStored()) return false;
  device.update(pickDevice(legacy));
  if (!host.load()) {
    const agents = Array.isArray(legacy.agents) ? (legacy.agents as Agent[]).map(migrateAgent) : [];
    host.save({ settings: pickHost(legacy), agents });
  }
  return true;
}
