/** A small stroke icon set, drawn in currentColor. */
const PATHS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  inbox: "M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1 2h6l1-2h5",
  chat: "M4 5h16v11H9l-5 4z",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4",
  fleet: "M5 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M13 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M3 20c0-3 3-5 5-5s5 2 5 5M11 20c0-3 3-5 5-5s5 2 5 5",
  board: "M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v6h-4z",
  panes: "M3 5h18v14H3zM7 10l3 2-3 2M12 15h5",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  panel: "M3 5h18v14H3zM15 5v14",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  left: "M14 7l-5 5 5 5",
  right: "M10 7l5 5-5 5",
  terminal: "M4 5h16v14H4zM8 10l3 2-3 2M13 14h3",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5A7 7 0 0 0 19 12z",
  play: "M8 5l11 7-11 7z",
  pause: "M8 5h3v14H8zM14 5h3v14h-3z",
  reset: "M4 12a8 8 0 1 0 3-6.2M4 4v4h4",
  stop: "M6 6h12v12H6z",
  send: "M4 12l16-8-6 16-2-6z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21a2 2 0 0 0 4 0",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
} as const;

export type IconName = keyof typeof PATHS;

/** Icons drawn as dots need a heavier stroke to read at small sizes. */
const STROKE: Partial<Record<IconName, string>> = { more: "3" };

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[name] ?? "1.8"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
