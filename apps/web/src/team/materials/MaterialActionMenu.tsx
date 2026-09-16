import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DropdownMenu, IconButton, type MenuEntry } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { materialUnavailableMessage } from '../errors';
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
  place: 'materialGroupPlace',
  remove: 'materialGroupRemove'
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
    note: availability.ok ? undefined : materialUnavailableMessage(availability.reason, t),
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
  className,
  contextTarget
}: {
  list: MaterialActionList;
  /** Names the menu — "Actions on <file>" — for assistive technology. */
  label: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /**
   * A selector for the ancestor that should open this menu on a right-click
   * (024, FR-021) — a row, a tile.
   *
   * The same list, from the same registry, in the place a file manager has
   * taught everyone to look for it. The browser's own menu is suppressed only
   * over that element: a right-click on the page, on a link, on selected text
   * still belongs to the browser, and taking it everywhere is how a web page
   * starts feeling like it is holding you hostage.
   */
  contextTarget?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /* A zero-size anchor parked where the pointer was: the menu's placement
     already knows how to keep itself on screen from a rect, and a point is a
     rect with no width. */
  const point = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextTarget) return;
    const host = trigger.current?.closest(contextTarget);
    if (!host) return;
    const onContextMenu = (event: Event) => {
      const mouse = event as MouseEvent;
      event.preventDefault();
      setAt({ x: mouse.clientX, y: mouse.clientY });
      setOpen(true);
    };
    host.addEventListener('contextmenu', onContextMenu);
    return () => host.removeEventListener('contextmenu', onContextMenu);
  }, [contextTarget, list.count]);

  if (list.count === 0) return null;

  return (
    <>
      {at && (
        <span
          ref={point}
          aria-hidden="true"
          style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0 }}
        />
      )}
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
        onClose={() => {
          setOpen(false);
          setAt(null);
        }}
        anchor={at ? point : trigger}
        placement={at ? 'bottom-start' : undefined}
        label={label}
        minWidth={224}
        items={materialMenuEntries(list, t)}
      />
    </>
  );
}
