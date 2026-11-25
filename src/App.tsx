import { useEffect, useState } from "react";
import type { AppInfo, Platform } from "./platform/index.ts";
import "./App.css";

export interface AppProps {
  platform: Platform;
}

/** Placeholder screen. The real UI shell replaces this. */
export function App({ platform }: AppProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let active = true;
    platform
      .appInfo()
      .then((next) => {
        if (active) setInfo(next);
      })
      .catch((error: unknown) => {
        console.error("app_info failed", error);
      });
    return () => {
      active = false;
    };
  }, [platform]);

  return (
    <main className="placeholder">
      <h1>rlxapp</h1>
      <p className="tagline">Coming soon.</p>
      <p className="meta" data-testid="app-meta">
        {info ? describe(info) : " "}
      </p>
    </main>
  );
}

function describe(info: AppInfo): string {
  if (info.runtime === "browser") {
    return `v${info.version} · browser preview`;
  }
  return `v${info.version} · ${info.os} (${info.arch})`;
}
