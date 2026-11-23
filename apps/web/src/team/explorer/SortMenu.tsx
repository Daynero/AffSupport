import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { Button, DropdownMenu, type MenuEntry } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import type { ExplorerSort, SortKey } from './sort';

/**
 * The sort control (011), modelled on a drive's: a button that opens a menu of
 * a sort key, a direction, and whether folders group above files. The button
 * shows the current key and turns with the direction.
 *
 * The menu itself is the inventory's (021, T091): it holds the outside-press
 * and Escape handling, the placement that flips when the window is short, and
 * the tick gutter that keeps the labels aligned whichever answer is current.
 */
export function SortMenu({
  sort,
  onChange
}: {
  sort: ExplorerSort;
  onChange: (sort: ExplorerSort) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const keyLabel = (key: SortKey) =>
    key === 'name'
      ? t('teamExplorerSortName')
      : key === 'kind'
        ? t('teamExplorerPaneKind')
        : key === 'modified'
          ? t('teamExplorerSortModified')
          : key === 'size'
            ? t('teamExplorerPaneSize')
            : key === 'tag'
              ? t('teamExplorerSortTag')
              : t('teamExplorerSortRank');

  const items: MenuEntry[] = [
    { heading: t('teamExplorerSortBy') },
    ...(['name', 'kind', 'modified', 'size', 'tag', 'rank'] as SortKey[]).map(key => ({
      id: `key-${key}`,
      label: keyLabel(key),
      checked: sort.key === key,
      onSelect: () => onChange({ ...sort, key })
    })),
    { heading: t('teamExplorerSortOrder') },
    ...(['asc', 'desc'] as const).map(direction => ({
      id: `direction-${direction}`,
      label: direction === 'asc' ? t('teamExplorerSortAsc') : t('teamExplorerSortDesc'),
      checked: sort.direction === direction,
      onSelect: () => onChange({ ...sort, direction })
    })),
    { heading: t('teamExplorerSortFolders') },
    ...[true, false].map(separate => ({
      id: `folders-${separate}`,
      label: separate ? t('teamExplorerSortFoldersSeparate') : t('teamExplorerSortFoldersMixed'),
      checked: sort.foldersSeparate === separate,
      onSelect: () => onChange({ ...sort, foldersSeparate: separate })
    }))
  ];

  return (
    <div className="team-explorer-sort">
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-haspopup="menu"
        leading={
          sort.direction === 'asc' ? (
            <ArrowUp size={16} strokeWidth={ICON_STROKE} />
          ) : (
            <ArrowDown size={16} strokeWidth={ICON_STROKE} />
          )
        }
        trailing={<ChevronDown size={16} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(value => !value)}
      >
        {keyLabel(sort.key)}
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-start"
        /* Three questions in one menu: answering one does not end the visit. */
        closeOnSelect={false}
        label={t('teamExplorerSortBy')}
        className="team-explorer-menu-sort"
        items={items}
      />
    </div>
  );
}
