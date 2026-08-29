import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ExplorerSort, SortKey } from './sort';

/**
 * The sort control (011), modelled on a drive's: a button that opens a menu of
 * a sort key, a direction, and whether folders group above files. The button
 * shows the current key and turns with the direction.
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
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const setKey = (key: SortKey) => onChange({ ...sort, key });
  const keyLabel = sort.key === 'name' ? t('teamExplorerSortName') : t('teamExplorerSortModified');

  return (
    <div className="team-explorer-sort" ref={ref}>
      <button
        type="button"
        className="team-explorer-filter-button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(value => !value)}
      >
        <span className="team-explorer-sort-icon" aria-hidden="true">
          {sort.direction === 'asc' ? '↑' : '↓'}
        </span>
        {keyLabel}
      </button>
      {open && (
        <div className="team-explorer-menu team-explorer-menu-sort" role="menu">
          <p className="team-explorer-menu-heading">{t('teamExplorerSortBy')}</p>
          {(['name', 'modified'] as SortKey[]).map(key => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={sort.key === key}
              className={`team-explorer-menu-item${sort.key === key ? ' is-checked' : ''}`}
              onClick={() => setKey(key)}
            >
              <span className="team-explorer-menu-check" aria-hidden="true">
                {sort.key === key ? '✓' : ''}
              </span>
              {key === 'name' ? t('teamExplorerSortName') : t('teamExplorerSortModified')}
            </button>
          ))}
          <p className="team-explorer-menu-heading">{t('teamExplorerSortOrder')}</p>
          {(['asc', 'desc'] as const).map(direction => (
            <button
              key={direction}
              type="button"
              role="menuitemradio"
              aria-checked={sort.direction === direction}
              className={`team-explorer-menu-item${sort.direction === direction ? ' is-checked' : ''}`}
              onClick={() => onChange({ ...sort, direction })}
            >
              <span className="team-explorer-menu-check" aria-hidden="true">
                {sort.direction === direction ? '✓' : ''}
              </span>
              {direction === 'asc' ? t('teamExplorerSortAsc') : t('teamExplorerSortDesc')}
            </button>
          ))}
          <p className="team-explorer-menu-heading">{t('teamExplorerSortFolders')}</p>
          {[true, false].map(separate => (
            <button
              key={String(separate)}
              type="button"
              role="menuitemradio"
              aria-checked={sort.foldersSeparate === separate}
              className={`team-explorer-menu-item${sort.foldersSeparate === separate ? ' is-checked' : ''}`}
              onClick={() => onChange({ ...sort, foldersSeparate: separate })}
            >
              <span className="team-explorer-menu-check" aria-hidden="true">
                {sort.foldersSeparate === separate ? '✓' : ''}
              </span>
              {separate ? t('teamExplorerSortFoldersSeparate') : t('teamExplorerSortFoldersMixed')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
