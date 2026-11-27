/**
 * The preview's fake host, made durable: until rlxd's settings API backs the core, the fake
 * host keeps its app settings and agents in the browser's storage under its own key, so they
 * survive a relaunch as they will on a real host. Only the composition root uses it.
 */
import { legacyHostData, legacyPending, migrateLegacySettings, type DeviceStorage, type DeviceStore } from "../device.ts";
import { MemoryHostStore, type HostData, type HostStore } from "../host.ts";

export const FAKE_HOST_STORAGE_KEY = "rlx.fake-host.v1";

export class LocalHostStore implements HostStore {
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly key: string;

  constructor(storage: Pick<Storage, "getItem" | "setItem"> | null, key = FAKE_HOST_STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
  }

  load(): HostData | null {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<HostData>;
      const data: HostData = { settings: parsed.settings ?? {}, agents: Array.isArray(parsed.agents) ? parsed.agents : [] };
      return typeof parsed.migratedFrom === "string" ? { ...data, migratedFrom: parsed.migratedFrom } : data;
    } catch {
      return null;
    }
  }

  save(data: HostData): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(data));
    } catch {
      // No storage: the fake host lasts for the session.
    }
  }
}

/**
 * The preview's host for this launch, in main.tsx's order: migrate rc's old settings key, then
 * hand the core its host. If the migration couldn't finish (a write failed), this launch's host
 * stays in memory, seeded with rc's data, so nothing the core writes can pass for the owner's
 * data; the next launch retries.
 */
export function openFakeHost(storage: DeviceStorage | null, device: DeviceStore): HostStore {
  const host = new LocalHostStore(storage);
  if (migrateLegacySettings(storage, device, host) || !legacyPending(storage)) return host;
  return new MemoryHostStore(legacyHostData(storage));
}
