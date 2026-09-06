/**
 * The marker filter (017, part 4), behind one control.
 *
 * As four chips it was four more things in a toolbar that already carried a
 * search, three occupancy chips and the fold — and colours are the filter
 * reached for least. So it is a single trigger that says what is selected, and
 * a small menu behind it, the same shape the tasks' date filter uses.
 *
 * The menu also holds the one thing that undoes a lot of marking at once:
 * clearing every marker in the space. It lives here because this is where a
 * person is when they notice the colours have stopped meaning anything, and
 * nowhere else in the toolbar is about markers.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Eraser } from 'lucide-react';
import {
  TEAM_AGENT_RUN_MARKERS,
  type TeamAccountMarkerFilter,
  type TeamAgentRunMarker
} from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';
import { ICON_STROKE } from '../../components/icons';

const OPTIONS: readonly TeamAccountMarkerFilter[] = ['all', ...TEAM_AGENT_RUN_MARKERS];

export function markerNameKey(value: TeamAccountMarkerFilter): TranslationKey {
  if (value === 'green') return 'teamAgentRunMarkerGreen';
  if (value === 'amber') return 'teamAgentRunMarkerAmber';
  if (value === 'red') return 'teamAgentRunMarkerRed';
  return 'teamAccountsFilterAll';
}

export function MarkerFilter({
  value,
  counts,
  total,
  marked,
  canEdit,
  onChange,
  onClearAll
}: {
  value: TeamAccountMarkerFilter;
  /** How many agents each colour would leave on screen. */
  counts: Record<TeamAgentRunMarker, number>;
  /** How many agents there are in all — the count beside "All". */
  total: number;
  /** How many runs carry a marker; nothing to clear when it is zero. */
  marked: number;
  canEdit: boolean;
  onChange: (value: TeamAccountMarkerFilter) => void;
  onClearAll: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes onto the trigger, so a keyboard is never left inside a
    // menu that is no longer on screen.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const count = (option: TeamAccountMarkerFilter) => (option === 'all' ? total : counts[option]);

  return (
    <div className="team-accounts-marker-filter" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`team-accounts-marker-trigger${value === 'all' ? '' : ' is-active'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(current => !current)}
      >
        {value !== 'all' && (
          <span className={`team-accounts-marker-dot is-${value}`} aria-hidden="true" />
        )}
        <span>{t('teamAccountsMarkerLabel')}</span>
        {value === 'all' ? (
          <b>{marked}</b>
        ) : (
          <span className="team-accounts-marker-selected">{t(markerNameKey(value))}</span>
        )}
      </button>
      {open && (
        <div
          className="team-accounts-marker-menu"
          role="dialog"
          aria-label={t('teamAccountsMarkerFilterLabel')}
        >
          {OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              className={`team-accounts-marker-option is-${option}${value === option ? ' is-active' : ''}`}
              aria-pressed={value === option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              <span className="team-accounts-marker-option-mark" aria-hidden="true">
                {value === option ? (
                  <Check size={14} strokeWidth={ICON_STROKE} />
                ) : option === 'all' ? null : (
                  <span className={`team-accounts-marker-dot is-${option}`} />
                )}
              </span>
              <span>{t(markerNameKey(option))}</span>
              <b>{count(option)}</b>
            </button>
          ))}
          {canEdit && (
            <button
              type="button"
              className="team-accounts-marker-clear"
              disabled={marked === 0}
              onClick={() => {
                onClearAll();
                setOpen(false);
              }}
            >
              <Eraser size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{t('teamAccountsMarkerClearAll')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
