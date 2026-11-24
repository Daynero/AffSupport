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

import { useRef, useState } from 'react';
import { ChevronDown, Eraser } from 'lucide-react';
import {
  TEAM_AGENT_RUN_MARKERS,
  type TeamAccountMarkerFilter,
  type TeamAgentRunMarker
} from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, DropdownMenu, type MenuEntry } from '../../components/ui/index';

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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const count = (option: TeamAccountMarkerFilter) => (option === 'all' ? total : counts[option]);
  /* The inventory's menu (070, T044): each colour is one answer to "which runs?",
     so it reads as a radio and carries a tick; clearing every marker is a
     command, parted from the answers by a line. */
  const items: MenuEntry[] = [
    ...OPTIONS.map(option => ({
      id: option,
      label: t(markerNameKey(option)),
      icon:
        option === 'all' ? undefined : (
          <span className={`team-accounts-marker-dot is-${option}`} aria-hidden="true" />
        ),
      trailing: <b className="numeric">{count(option)}</b>,
      checked: value === option,
      onSelect: () => onChange(option)
    })),
    ...(canEdit
      ? [
          'separator' as const,
          {
            id: 'clear',
            label: t('teamAccountsMarkerClearAll'),
            icon: <Eraser size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
            disabled: marked === 0,
            onSelect: onClearAll
          }
        ]
      : [])
  ];

  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant={value === 'all' ? 'ghost' : 'soft'}
        color={value === 'all' ? 'neutral' : 'secondary'}
        className={`team-accounts-marker-trigger${value === 'all' ? '' : ' is-active'}`}
        aria-expanded={open}
        aria-haspopup="menu"
        leading={
          value !== 'all' ? (
            <span className={`team-accounts-marker-dot is-${value}`} aria-hidden="true" />
          ) : undefined
        }
        trailing={<ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(current => !current)}
      >
        {t('teamAccountsMarkerLabel')}{' '}
        {value === 'all' ? (
          <b className="numeric">{marked}</b>
        ) : (
          <span className="team-accounts-marker-selected">{t(markerNameKey(value))}</span>
        )}
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-end"
        label={t('teamAccountsMarkerFilterLabel')}
        items={items}
      />
    </>
  );
}
