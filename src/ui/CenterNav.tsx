import type { ReactNode } from "react";

export interface CenterTab {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

/**
 * The slim navigation line across the top of the centre (2-way split, owner amendment 4): a
 * breadcrumb or title, the item's tabs or sections, and its actions (one primary, the rest in
 * ⋯). It replaces the old right-hand column: details open in place below it, never beside it.
 */
export function CenterNav({
  crumbs = [],
  title,
  lead,
  tabs,
  tabsLabel,
  sections,
  actions,
}: {
  crumbs?: { label: string; onSelect: () => void }[];
  title: ReactNode;
  lead?: ReactNode;
  tabs?: CenterTab[];
  tabsLabel?: string;
  /** In-page sections (links that scroll), when the item is one long page. */
  sections?: { id: string; label: string }[];
  actions?: ReactNode;
}) {
  return (
    <header className="center-nav" data-testid="center-nav">
      <div className="center-nav__title">
        {lead}
        <div className="center-nav__heading">
          {crumbs.length ? (
            <ol className="center-nav__crumbs" aria-label="Where you are">
              {crumbs.map((c) => (
                <li key={c.label}>
                  <button type="button" className="center-nav__crumb" onClick={c.onSelect}>
                    {c.label}
                  </button>
                  <span aria-hidden="true"> › </span>
                </li>
              ))}
            </ol>
          ) : null}
          <h1>{title}</h1>
        </div>
      </div>
      {tabs?.length ? (
        <div className="tabs center-nav__tabs" role="tablist" aria-label={tabsLabel}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.active} className={`tab${t.active ? " is-active" : ""}`} onClick={t.onSelect}>
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {sections?.length ? (
        <nav className="center-nav__tabs" aria-label="Sections">
          {sections.map((s) => (
            <a
              key={s.id}
              className="tab"
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      ) : null}
      {actions ? <div className="center-nav__actions">{actions}</div> : null}
    </header>
  );
}
