import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon.tsx";
import { openOverlay } from "./overlays.ts";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * The ⋯ menu: a card's secondary actions, so each card shows one primary action (calm rule).
 * Opens on click, Enter or Space; arrow keys move; Escape or a click outside closes it.
 */
export function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = openOverlay();
    const node = root.current;
    node?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (node && !node.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      close();
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const entries = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".more-menu__button")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="more-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="icon-button icon-button--sm more-menu__button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div className="more-menu__list" role="menu" id={id} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="more-menu__item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
