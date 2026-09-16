import { MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { DropdownMenu, IconButton, type MenuEntry } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import type { MaterialActionGroup } from './actions';
import type { MaterialActionList, ResolvedAction } from './useMaterialActionList';

/**
 * Everything that can be done to a material, in one menu, everywhere.
 *
 * The explorer's row menu could carry eleven items for one video: stacked
 * full-width text buttons, no grouping, no icons, and "Move to trash" flush
 * against "Rename" with nothing between them. A reader could not tell at a
 * glance which of the eleven were safe.
 *
 * Here they are grouped by what the reader wants — open it, get it, make
 * something from it, tidy it, remove it — with the destructive group last,
 * separated, and never the item the keyboard lands on first.
 */

const GROUP_HEADINGS: Record<MaterialActionGroup, TranslationKey> = {
  open: 'materialGroupOpen',
  get: 'materialGroupGet',
  make: 'materialGroupMake',
  organise: 'materialGroupOrganise',
  remove: 'materialGroupRemove'
};

const REASON_COPY: Record<string, TranslationKey> = {
  NO_PERMISSION: 'materialReasonNoPermission',
  AGENT_REQUIRED: 'materialReasonAgentRequired',
  STORAGE_DISCONNECTED: 'materialReasonStorageDisconnected',
  CATALOG_SETTINGS_MISSING: 'materialReasonCatalogSettings',
  RESTITCH_UNCONFIGURED: 'materialReasonRestitchUnconfigured',
  NOT_READY: 'materialReasonNotReady',
  TRASHED: 'materialReasonTrashed',
  MISSING: 'materialReasonMissing'
};

/** One resolved action as a menu row, carrying its reason when it has one. */
function toEntry(entry: ResolvedAction, t: (key: TranslationKey) => string): MenuEntry {
  const { action, availability, run } = entry;
  const Icon = action.icon;
  return {
    id: action.id,
    label: t(action.labelKey),
    icon: <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
    destructive: action.destructive,
    disabled: !availability.ok,
    note: availability.ok ? undefined : t(REASON_COPY[availability.reason] ?? 'teamActionFailed'),
    onSelect: run
  };
}

export function materialMenuEntries(
  list: MaterialActionList,
  t: (key: TranslationKey) => string
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const group of list.groups) {
    if (entries.length > 0) entries.push('separator');
    // A heading on a group of one still earns its line: it is what makes the
    // list scannable rather than a column of words.
    entries.push({ heading: t(GROUP_HEADINGS[group.group]) });
    for (const action of group.actions) entries.push(toEntry(action, t));
  }
  return entries;
}

export function MaterialActionMenu({
  list,
  label,
  size = 'sm',
  className
}: {
  list: MaterialActionList;
  /** Names the menu — "Actions on <file>" — for assistive technology. */
  label: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  if (list.count === 0) return null;

  return (
    <>
      <IconButton
        ref={trigger}
        label={label}
        size={size}
        variant="ghost"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        label={label}
        minWidth={224}
        items={materialMenuEntries(list, t)}
      />
    </>
  );
}
