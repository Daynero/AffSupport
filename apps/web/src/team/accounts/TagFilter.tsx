import { useRef, useState } from 'react';
import { ChevronDown, Tag } from 'lucide-react';
import type { TeamTaskLabel } from '@video-compressor/shared';
import { Button, DropdownMenu } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/**
 * One agent tag to keep (070, T047), beside the colours.
 *
 * A tag is how a team names a batch of ad accounts — "#2", "Hot" — and until
 * now the only way to see one batch was to read every row for its chip. The
 * same press is on the account heads: a tag's count there filters by it too
 * (T046), so the head and this menu are two doors to one state.
 */
export function TagFilter({
  value,
  tags,
  counts,
  onChange
}: {
  /** The kept tag's id, or null for every agent. */
  value: string | null;
  /** The agent half of the space's tag dictionary. */
  tags: readonly TeamTaskLabel[];
  /** How many of the agents the search leaves carry each tag. */
  counts: ReadonlyMap<string, { count: number }>;
  onChange: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const chosen = tags.find(tag => tag.id === value) ?? null;
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant={chosen ? 'soft' : 'ghost'}
        color={chosen ? 'secondary' : 'neutral'}
        className={`team-accounts-tag-trigger${chosen ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        leading={<Tag size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        trailing={<ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(current => !current)}
      >
        {chosen ? chosen.name : t('teamAccountsTagFilter')}
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-end"
        label={t('teamAccountsTagFilterLabel')}
        items={[
          {
            id: 'all',
            label: t('teamAccountsTagFilterAll'),
            checked: value === null,
            onSelect: () => onChange(null)
          },
          ...tags.map(tag => ({
            id: tag.id,
            label: tag.name,
            icon: (
              <span
                className="team-task-label-chip-dot team-accounts-tag-dot"
                data-color={tag.color}
                aria-hidden="true"
              />
            ),
            trailing: <b className="numeric">{counts.get(tag.id)?.count ?? 0}</b>,
            checked: value === tag.id,
            onSelect: () => onChange(tag.id)
          }))
        ]}
      />
    </>
  );
}
