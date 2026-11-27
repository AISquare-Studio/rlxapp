/**
 * Device-local settings: the only app state kept in this device's storage (localStorage).
 * Everything else lives with the host and comes through the core.
 */
import { DEVICE_SETTING_KEYS, type DeviceSettings } from "../state/model.ts";

export const DEVICE_STORAGE_KEY = "rlx.device.v1";

/** Before the core seam, the app kept all its settings here; nothing may stay in it now. */
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

export function loadDeviceSettings(storage: DeviceStorage | null): DeviceSettings {
  if (!storage) return { ...DEFAULT_DEVICE_SETTINGS };
  try {
    storage.removeItem(LEGACY_SETTINGS_KEY);
    const raw = storage.getItem(DEVICE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { ...DEFAULT_DEVICE_SETTINGS, ...pickDevice(parsed) };
  } catch {
    return { ...DEFAULT_DEVICE_SETTINGS };
  }
}

export function saveDeviceSettings(storage: DeviceStorage | null, settings: DeviceSettings): void {
  try {
    storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(pickDevice(settings as unknown as Record<string, unknown>)));
  } catch {
    // Storage can be unavailable (private mode); device settings then last for the session.
  }
}
