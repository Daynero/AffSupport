import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredLayer } from '../components/useAnchoredLayer';
import type { Language } from '../i18n';
import { languageDisplayName } from './language';

/**
 * One searchable language picker for every place a target language is chosen.
 *
 * The list is fifty-odd entries, which is past what a native `<select>` can be scanned by
 * eye; typing three letters is faster than scrolling, and the same control in the row and
 * in the viewer means a person learns it once.
 */
function optionIdFor(listId: string, code: string): string {
  return `${listId}-${code.replace(/[^A-Za-z0-9]/gu, '-')}`;
}

export const LanguageCombobox = memo(function LanguageCombobox({
  value,
  codes,
  language,
  label,
  compact = false,
  disabled = false,
  /** What the code `auto` is called, for a picker that offers automatic detection. */
  autoLabel,
  /**
   * Codes to keep at the top of the list, in this order.
   *
   * Used where the likely answers are known in advance — the languages Whisper mistakes
   * for the one it named — so correcting a misdetection is a glance rather than a search
   * through a hundred names.
   */
  pinned,
  emptyLabel,
  ariaLabelledBy,
  portal = false,
  onChange
}: {
  value: string;
  codes: readonly string[];
  language: Language;
  label: string;
  /** Inline in a row: sized to its text, styled as a quiet control rather than a field. */
  compact?: boolean;
  disabled?: boolean;
  autoLabel?: string;
  pinned?: readonly string[];
  /** Shown when the search matches nothing. */
  emptyLabel?: string;
  /** The visible label's id, when there is one; the accessible name then follows it. */
  ariaLabelledBy?: string;
  /** The list on the body, placed under the field: inside a list card the card clips it. */
  portal?: boolean;
  onChange: (code: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const layerStyle = useAnchoredLayer(field, list, open && portal, {
    matchWidth: true,
    // A chip-sized field still needs a list wide enough to read a language name in.
    minWidth: 220,
    maxHeight: 240
  });
  /*
   * What has been typed, or `null` for "nothing typed — show the chosen language".
   *
   * An empty string is a real state and a different one: it is the field cleared to type a
   * search into. Conflating the two meant deleting the last character redrew the language's
   * name, so the field could not be emptied at all.
   */
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const name = (code: string) =>
    code === 'auto' && autoLabel ? autoLabel : languageDisplayName(code, language);
  const options = useMemo(() => {
    const top = (pinned ?? []).filter(code => code !== 'auto' && codes.includes(code));
    const promoted = new Set(top);
    const named = codes
      .filter(code => code !== 'auto' && !promoted.has(code))
      .map(code => ({ code, name: languageDisplayName(code, language), pinned: false }))
      .sort((left, right) => left.name.localeCompare(right.name, language));
    // Automatic detection, when offered, stays first rather than sorting into the A's, and
    // the pinned answers follow it in the order they were given.
    return [
      ...(codes.includes('auto') && autoLabel
        ? [{ code: 'auto', name: autoLabel, pinned: false }]
        : []),
      ...top.map(code => ({ code, name: languageDisplayName(code, language), pinned: true })),
      ...named
    ];
  }, [codes, language, autoLabel, pinned]);
  const filtered = useMemo(() => {
    const needle = (query ?? '').trim().toLocaleLowerCase(language);
    return needle
      ? options.filter(item => item.name.toLocaleLowerCase(language).includes(needle))
      : options;
  }, [options, language, query]);

  // While the person has typed nothing the highlight sits on the current choice; it used to
  // sit on the first name alphabetically, so Enter on a freshly opened list quietly switched
  // a Ukrainian target to Arabic.
  useEffect(() => {
    if (query) {
      setActiveIndex(0);
      return;
    }
    const current = filtered.findIndex(item => item.code === value);
    setActiveIndex(current < 0 ? 0 : current);
  }, [query, filtered, value, open]);
  // The keyboard's choice stays in view; arrowing past the bottom of the list used to move
  // the highlight out of sight.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(listId)
      ?.querySelector<HTMLElement>('li.is-active')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery(null);
  };
  const optionId = (code: string) => optionIdFor(listId, code);
  // What the field reads right now: what is being typed, or the language that is chosen.
  const shown = open && query !== null ? query : name(value);

  return (
    <div
      ref={field}
      className={`transcript-language-combobox${compact ? ' is-compact' : ''}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery(null);
        }
      }}
    >
      <input
        role="combobox"
        aria-label={ariaLabelledBy ? undefined : label}
        aria-labelledby={ariaLabelledBy}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && filtered[activeIndex] ? optionId(filtered[activeIndex].code) : undefined
        }
        disabled={disabled}
        // Lets a chip-sized picker hug the name it shows, where the stylesheet leaves the
        // field's width to its content; ignored wherever the field is given a width.
        size={compact ? Math.max(6, shown.length + 1) : undefined}
        value={shown}
        onFocus={event => {
          setOpen(true);
          setQuery(null);
          // Selected, so the first keystroke replaces the name rather than appending to it.
          event.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onChange={event => {
          setOpen(true);
          setQuery(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(index => (filtered.length ? (index + 1) % filtered.length : 0));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index =>
              filtered.length ? (index - 1 + filtered.length) % filtered.length : 0
            );
          } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
            event.preventDefault();
            choose(filtered[activeIndex].code);
          } else if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
            setQuery(null);
          }
        }}
      />
      {open &&
        (portal ? (
          createPortal(
            <ul
              id={listId}
              ref={list}
              role="listbox"
              className="transcript-language-listbox is-portal"
              style={layerStyle ?? undefined}
            >
              {filtered.length ? (
                filtered.map((item, index) => (
                  <li
                    id={optionId(item.code)}
                    key={item.code}
                    role="option"
                    aria-selected={item.code === value}
                    className={`${index === activeIndex ? 'is-active' : ''}${
                      item.pinned ? ' is-pinned' : ''
                    }`.trim()}
                    onPointerDown={event => event.preventDefault()}
                    onClick={() => choose(item.code)}
                  >
                    {item.name}
                  </li>
                ))
              ) : (
                <li className="is-empty">{emptyLabel ?? label}</li>
              )}
            </ul>,
            document.body
          )
        ) : (
          <ul id={listId} ref={list} role="listbox">
            {filtered.length ? (
              filtered.map((item, index) => (
                <li
                  id={optionId(item.code)}
                  key={item.code}
                  role="option"
                  aria-selected={item.code === value}
                  className={`${index === activeIndex ? 'is-active' : ''}${
                    item.pinned ? ' is-pinned' : ''
                  }`.trim()}
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => choose(item.code)}
                >
                  {item.name}
                </li>
              ))
            ) : (
              <li className="is-empty">{emptyLabel ?? label}</li>
            )}
          </ul>
        ))}
    </div>
  );
});
