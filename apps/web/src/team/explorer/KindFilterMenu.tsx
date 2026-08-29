import { useEffect, useRef, useState } from 'react';
import type { TeamMaterialRowKind } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { KIND_LABEL } from './rowKinds';

const FILTER_KINDS: TeamMaterialRowKind[] = [
  'landing',
  'image',
  'video',
  'transcript',
  'archive',
  'other'
];

/**
 * The kind filter as a "Тип" dropdown (011), the way a drive puts it: one
 * button, a menu of kinds, the chosen ones summarised on the button with a way
 * to clear them. Folders are never filtered — they are how you move around.
 */
export function KindFilterMenu({
  kinds,
  onChange
}: {
  kinds: TeamMaterialRowKind[];
  onChange: (kinds: TeamMaterialRowKind[]) => void;
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

  const toggle = (kind: TeamMaterialRowKind) =>
    onChange(kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind]);

  const label =
    kinds.length === 0
      ? t('teamExplorerFilterType')
      : kinds.length === 1
        ? t(KIND_LABEL[kinds[0]!])
        : t('teamExplorerFilterTypeCount', { count: kinds.length });

  return (
    <div className="team-explorer-filter" ref={ref}>
      <button
        type="button"
        className={`team-explorer-filter-button${kinds.length > 0 ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(value => !value)}
      >
        {label}
        <span aria-hidden="true" className="team-explorer-filter-caret">
          ▾
        </span>
      </button>
      {kinds.length > 0 && (
        <button
          type="button"
          className="team-explorer-filter-clear"
          aria-label={t('teamExplorerFilterClear')}
          title={t('teamExplorerFilterClear')}
          onClick={() => onChange([])}
        >
          ✕
        </button>
      )}
      {open && (
        <div className="team-explorer-menu" role="menu">
          {FILTER_KINDS.map(kind => (
            <button
              key={kind}
              type="button"
              role="menuitemcheckbox"
              aria-checked={kinds.includes(kind)}
              className={`team-explorer-menu-item${kinds.includes(kind) ? ' is-checked' : ''}`}
              onClick={() => toggle(kind)}
            >
              <span className="team-explorer-menu-check" aria-hidden="true">
                {kinds.includes(kind) ? '✓' : ''}
              </span>
              {t(KIND_LABEL[kind])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
