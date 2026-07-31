import { useRef, type KeyboardEvent } from 'react';

export interface TabDef {
  id: string;
  label: string;
  badge?: number;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}

/* nilam ships a tabs() behaviour, but it wires a tablist by mutating the DOM — roles, ids and
 * tabindex — which is the one thing not to do inside React. So this reimplements the same
 * contract in React and keeps nilam's markup exactly: .n-tabs / .n-tab, and aria-selected as
 * the styling hook. nilam's note on that is a forcing function worth respecting — the
 * underline is driven off aria-selected, so an inaccessible tablist visibly loses its
 * selected state instead of silently working.
 *
 * Automatic activation, per the APG: these panels are local state with no fetch behind them,
 * so arrowing should switch them. Manual activation would cost a keyboard user two keys per
 * tab and tell a screen-reader user nothing while arrowing. */
export const Tabs = ({ tabs, active, onChange }: TabsProps) => {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const order = tabs.map((t) => t.id);
    const at = order.indexOf(active);
    let next = -1;
    if (event.key === 'ArrowRight') next = (at + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = order[next]!;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div className="n-tabs" role="tablist" aria-label="flai sections" onKeyDown={move}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            className="n-tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            // Roving tabindex: one stop for the whole tablist, arrows move within it.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.badge ? (
              <span className="n-badge n-badge-brand flai-tab-badge">{tab.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

interface PanelProps {
  id: string;
  active: string;
  children: React.ReactNode;
}

export const TabPanel = ({ id, active, children }: PanelProps) =>
  id === active ? (
    // tabIndex={-1} so a programmatic focus can land here after a tab change, without adding
    // a tab stop for a panel that is just a container.
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1} className="n-stack">
      {children}
    </div>
  ) : null;
