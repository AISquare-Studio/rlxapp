import { connectorLabel, type ConnectorId } from "../core/connectors.ts";

export interface GenericManifest {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  source: "builtin" | "agent" | "user";
  data: { connector: ConnectorId; tools: string[]; prompt: string; every: { minutes: number } };
}

/** A generic per-connector widget, rendered from a manifest and the shared Feed schema (architecture §5.5). */
export function genericManifest(connector: ConnectorId): GenericManifest {
  return {
    schemaVersion: 1,
    id: "generic-connector",
    version: 1,
    title: connectorLabel(connector),
    source: "builtin",
    data: {
      connector,
      tools: ["read tools only"],
      prompt: "Up to 10 recent items that matter to {{owner}}; set needsYou when they need the owner.",
      every: { minutes: 15 },
    },
  };
}
