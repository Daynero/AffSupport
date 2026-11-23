import { useRef, useState } from 'react';
import type { TeamMaterialRowKind } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { ChevronDown, X } from 'lucide-react';
import { Button, DropdownMenu, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
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
      {/* The inventory's quiet button, at the strip's size (070, T012): it was a bare `<button>`
          with its own pill, and the clear beside it a bare "✕". */}
      <Button
        ref={trigger}
        /* A narrowed list says so in the selection colour, as a chosen tab does. */
        color={kinds.length > 0 ? 'secondary' : 'neutral'}
        variant={kinds.length > 0 ? 'soft' : 'outline'}
        size="sm"
        aria-expanded={open}
        aria-haspopup="menu"
        trailing={<ChevronDown size={16} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(value => !value)}
      >
        {label}
      </Button>
      {kinds.length > 0 && (
        <IconButton size="sm" label={t('teamExplorerFilterClear')} onClick={() => onChange([])}>
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
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
