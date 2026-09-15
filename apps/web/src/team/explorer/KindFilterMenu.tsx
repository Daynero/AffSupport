import { useRef, useState } from 'react';
import type { TeamMaterialRowKind } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { DropdownMenu } from '../../components/ui/index';
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
 *
 * The menu is the inventory's (021, T091); the kinds are a set rather than a
 * choice, so each one is a checkbox and picking one does not close it.
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
  const trigger = useRef<HTMLButtonElement | null>(null);

  const toggle = (kind: TeamMaterialRowKind) =>
    onChange(kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind]);

  const label =
    kinds.length === 0
      ? t('teamExplorerFilterType')
      : kinds.length === 1
        ? t(KIND_LABEL[kinds[0]!])
        : t('teamExplorerFilterTypeCount', { count: kinds.length });

  return (
    <div className="team-explorer-filter">
      <button
        ref={trigger}
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
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-start"
        selection="multiple"
        closeOnSelect={false}
        label={t('teamExplorerFilterType')}
        items={FILTER_KINDS.map(kind => ({
          id: kind,
          label: t(KIND_LABEL[kind]),
          checked: kinds.includes(kind),
          onSelect: () => toggle(kind)
        }))}
      />
    </div>
  );
}
