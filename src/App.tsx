import { useEffect, useState } from "react";
import { RlxMark } from "./brand/RlxMark.tsx";
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
    <div className="app">
      <header className="app-header">
        <RlxMark className="app-header__mark" />
      </header>
      <main className="placeholder">
        <h1>rlx</h1>
        <p className="tagline">Coming soon.</p>
        <p className="meta" data-testid="app-meta">
          {info ? describe(info) : " "}
        </p>
      </main>
    </div>
  );
}

function describe(info: AppInfo): string {
  if (info.runtime === "browser") {
    return `v${info.version} · browser preview`;
  }
  return `v${info.version} · ${info.os} (${info.arch})`;
}
