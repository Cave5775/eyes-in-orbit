import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { searchLaunchGroups, type LaunchGroup, type LaunchMode } from '../lib/filters';
import { useStore } from '../state/store';

const MAX_OPTIONS = 40;
const MODES: [LaunchMode, string, string][] = [
  ['only', 'SHOW ONLY', 'Hide every object outside the launch in the scene'],
  ['highlight', 'HIGHLIGHT', 'Keep other objects visible but dimmed'],
];

/** Searchable combobox of launch groups (objects sharing a launch id) with a show-only / highlight switch. */
export function LaunchFilter({ groups }: { groups: LaunchGroup[] }) {
  const launch = useStore((s) => s.filters.launch ?? null);
  const mode = useStore((s) => s.filters.launchMode ?? 'only');
  const { setLaunchFilter, setLaunchMode } = useStore.getState();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();

  const options = useMemo(() => searchLaunchGroups(groups, text, MAX_OPTIONS), [groups, text]);
  const active = launch ? groups.find((g) => g.id === launch) : undefined;

  const choose = (g: LaunchGroup) => {
    setLaunchFilter(g.id, g.ids);
    setText('');
    setOpen(false);
  };
  const clear = () => {
    setLaunchFilter(null);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(c + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter' && open && options[cursor]) {
      e.preventDefault();
      choose(options[cursor]);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="launch-filter">
      <div className="launch-head dim">LAUNCH</div>
      <input
        type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label="Filter by launch"
        placeholder={groups.length ? 'Launch: COSMOS 2251, 1993-036...' : 'No launch groups yet'}
        value={text} spellCheck={false} disabled={!groups.length && !launch}
        onChange={(e) => { setText(e.target.value); setCursor(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {open && (
        <ul id={listId} role="listbox" className="launch-options" onMouseDown={(e) => e.preventDefault()}>
          {options.length === 0 && <li className="launch-none dim">No launch matches.</li>}
          {options.map((g, i) => (
            <li
              key={g.id} role="option" aria-selected={g.id === launch}
              className={i === cursor ? 'launch-opt cur' : 'launch-opt'}
              onMouseEnter={() => setCursor(i)} onClick={() => choose(g)}
            >
              <span className="launch-opt-name">{g.label}</span>
              <span className="launch-opt-id mono dim">{g.id}</span>
              <span className="launch-opt-n mono">{g.count.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
      )}
      {launch && (
        <div className="launch-active">
          <button className="chip on launch-chip" onClick={clear} title="Clear the launch filter" aria-label={`Clear launch filter ${active?.label ?? launch}`}>
            <span className="launch-chip-name">{active?.label ?? launch}</span>
            <small>{active ? `${active.id} / ${active.count.toLocaleString('en-US')}` : 'no members'}</small>
            <span aria-hidden="true">x</span>
          </button>
          <div className="seg" role="group" aria-label="Launch filter mode">
            {MODES.map(([m, label, tip]) => (
              <button key={m} className={m === mode ? 'seg-btn on' : 'seg-btn'} aria-pressed={m === mode} title={tip} onClick={() => setLaunchMode(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
