import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { DropdownMenu, type MenuEntry } from '../../components/ui/index';
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
      : key === 'modified'
        ? t('teamExplorerSortModified')
        : t('teamExplorerSortTag');

  const items: MenuEntry[] = [
    { heading: t('teamExplorerSortBy') },
    ...(['name', 'modified', 'tag'] as SortKey[]).map(key => ({
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
      label: separate
        ? t('teamExplorerSortFoldersSeparate')
        : t('teamExplorerSortFoldersMixed'),
      checked: sort.foldersSeparate === separate,
      onSelect: () => onChange({ ...sort, foldersSeparate: separate })
    }))
  ];

  return (
    <div className="team-explorer-sort">
      <button
        ref={trigger}
        type="button"
        className="team-explorer-filter-button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(value => !value)}
      >
        <span className="team-explorer-sort-icon" aria-hidden="true">
          {sort.direction === 'asc' ? '↑' : '↓'}
        </span>
        {keyLabel(sort.key)}
      </button>
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
