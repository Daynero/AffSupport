import { useRef, useState } from 'react';
import {
  ChevronDown,
  History as HistoryIcon,
  Keyboard,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2
} from 'lucide-react';
import type { TeamContextSnapshot } from '../../api/team';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, DropdownMenu, IconButton, type MenuEntry } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { NARROW_SM_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { formatShortcut, shortcutOf } from '../palette/shortcuts';
import { SpaceHealth, type SpaceHealthProps } from './SpaceHealth';
import { SpaceSwitcher } from './SpaceSwitcher';

export interface SpaceHeaderMenu {
  onSettings: () => void;
  onUpdater: () => void;
  /** Present when the reader may process and the space can be browsed. */
  onProcessSpace?: () => void;
  /** Present for owners and admins. */
  onHistory?: () => void;
  onTrash: () => void;
  onShortcuts: () => void;
}

/**
 * The space's header row (070, US5): where you are, how the space is, and two ways on.
 *
 * Name and switcher on the left; on the right the space's health (one quiet indicator, or the
 * chips that need a person), «Перейти до… ⌘K» and the space's menu. Both are the inventory's
 * buttons now (T029) — they were raw `<button>`s dressed as chips. On a phone both shrink to
 * their icons and the row stays one row (T078): the name gives way, never the menu.
 *
 * The catalog manager used to sit here as a link of its own, «За розкладом» when it had
 * something scheduled; it says what it is doing in the health panel now, and its door is a row
 * of the space's menu.
 */
export function SpaceHeader({
  activeTeam,
  teams,
  health,
  onFind,
  menu
}: {
  activeTeam: TeamContextSnapshot | null;
  teams: TeamContextSnapshot[];
  health: SpaceHealthProps | null;
  onFind: () => void;
  menu: SpaceHeaderMenu;
}) {
  const { t } = useI18n();
  const narrow = useMediaQuery(NARROW_SM_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const chord = formatShortcut(shortcutOf('palette')!.keys);
  const icon = (Icon: typeof Settings) => (
    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
  );

  const items: MenuEntry[] = [
    {
      id: 'settings',
      label: t('teamSpaceSettings'),
      icon: icon(Settings),
      onSelect: menu.onSettings
    },
    /* Grouped by what they are about (024): the space itself, the work it runs, its record and
       its bin, then help. */
    'separator',
    {
      id: 'updater',
      label: t('catalogUpdaterEntry'),
      icon: icon(RefreshCw),
      onSelect: menu.onUpdater
    },
    /* The whole space at once, in the space's menu (024): a folder's own "Process" menu and a
       selection's "Process N" stay where the files are. */
    ...(menu.onProcessSpace
      ? [
          {
            id: 'process-space',
            label: t('teamProcessWholeSpace'),
            icon: icon(Sparkles),
            onSelect: menu.onProcessSpace
          } satisfies MenuEntry
        ]
      : []),
    'separator',
    ...(menu.onHistory
      ? [
          {
            id: 'history',
            label: t('teamAuditTitle'),
            icon: icon(HistoryIcon),
            onSelect: menu.onHistory
          } satisfies MenuEntry
        ]
      : []),
    { id: 'trash', label: t('teamTrashEntry'), icon: icon(Trash2), onSelect: menu.onTrash },
    'separator',
    {
      id: 'shortcuts',
      label: t('shortcutSheet'),
      icon: icon(Keyboard),
      trailing: formatShortcut(shortcutOf('shortcuts')!.keys),
      onSelect: menu.onShortcuts
    }
  ];

  return (
    <header className="team-space-shell-header">
      <div className="team-space-shell-identity">
        <SpaceSwitcher activeTeam={activeTeam} teams={teams} headingId="team-space-shell-title" />
      </div>
      {health && <SpaceHealth {...health} />}
      <div className="team-space-shell-utilities">
        {/* One way in, said on screen (024, FR-094): the palette had only a chord. */}
        {narrow ? (
          <IconButton
            size="sm"
            variant="ghost"
            className="team-space-shell-find"
            label={`${t('teamSpaceFind')} (${chord})`}
            onClick={onFind}
          >
            <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        ) : (
          <Button
            size="sm"
            variant="outline"
            color="neutral"
            className="team-space-shell-find"
            aria-label={`${t('teamSpaceFind')} (${chord})`}
            leading={<Search size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            trailing={<kbd>{chord}</kbd>}
            onClick={onFind}
          >
            {t('teamSpaceFind')}
          </Button>
        )}
        {narrow ? (
          <IconButton
            ref={menuTrigger}
            size="sm"
            variant="ghost"
            className="team-space-shell-menu"
            label={t('teamSpaceMenu')}
            title=""
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        ) : (
          <Button
            ref={menuTrigger}
            size="sm"
            variant="ghost"
            color="neutral"
            className="team-space-shell-menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            trailing={<ChevronDown size={14} strokeWidth={ICON_STROKE} />}
            onClick={() => setMenuOpen(true)}
          >
            {t('teamSpaceMenu')}
          </Button>
        )}
        <DropdownMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchor={menuTrigger}
          placement="bottom-end"
          label={t('teamSpaceMenu')}
          items={items}
        />
      </div>
    </header>
  );
}
