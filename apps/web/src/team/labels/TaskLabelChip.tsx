/**
 * The one shape a tag takes anywhere in the product (018): a pill in the tag's
 * own colour, carrying its name.
 *
 * Cards show it flat, the editor shows it with a × to take it off, the picker
 * and the filter show it as a button. Everything else — the colour, the
 * radius, the type — comes from here, so a tag cannot look like two things.
 */

import { X } from 'lucide-react';
import {
  TEAM_TASK_LABEL_COLORS,
  sortTeamTaskLabels,
  type TeamTaskLabelColor,
  type TeamTaskLabelRef
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { IconButton, RadioGroup } from '../../components/ui/index';

const COLOR_NAME: Record<TeamTaskLabelColor, TranslationKey> = {
  purple: 'teamTaskTagColorPurple',
  blue: 'teamTaskTagColorBlue',
  teal: 'teamTaskTagColorTeal',
  green: 'teamTaskTagColorGreen',
  honey: 'teamTaskTagColorHoney',
  orange: 'teamTaskTagColorOrange',
  red: 'teamTaskTagColorRed',
  pink: 'teamTaskTagColorPink',
  slate: 'teamTaskTagColorSlate'
};

export function taskLabelColorNameKey(color: TeamTaskLabelColor): TranslationKey {
  return COLOR_NAME[color];
}

export function TaskLabelChip({
  label,
  selected = false,
  onRemove,
  removeLabel,
  disabled = false
}: {
  label: TeamTaskLabelRef;
  /** Marks the chip as chosen — the picker and the filter both use it. */
  selected?: boolean;
  onSelect?: () => void;
  /** Adds the × that takes the tag off a task. */
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const className = `team-task-label-chip${selected ? ' is-selected' : ''}`;
  const body = (
    <>
      <span className="team-task-label-chip-dot" aria-hidden="true" />
      <span className="team-task-label-chip-name">{label.name}</span>
    </>
  );

  return (
    <span className={className} data-color={label.color}>
      {body}
      {onRemove && (
        <IconButton
          size="xs"
          className="team-task-label-chip-remove"
          label={removeLabel ?? t('teamTaskTagRemove', { name: label.name })}
          disabled={disabled}
          onClick={onRemove}
        >
          <X size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
    </span>
  );
}

/**
 * The tags on a card, read-only. Past `limit` the rest fold into one "+N"
 * whose tooltip names them, so a task on five tags keeps a one-line strip.
 */
export function TaskLabelChips({
  labels,
  limit
}: {
  labels: readonly TeamTaskLabelRef[];
  limit?: number;
}) {
  const { t } = useI18n();
  if (labels.length === 0) return null;
  const sorted = sortTeamTaskLabels(labels);
  const shown = limit !== undefined && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  const rest = sorted.slice(shown.length);
  return (
    <div className="team-task-label-chips" aria-label={t('teamTaskTagsLabel')}>
      {shown.map(label => (
        <TaskLabelChip key={label.id} label={label} />
      ))}
      {rest.length > 0 && (
        <span
          className="team-task-label-chip is-more"
          title={rest.map(label => label.name).join('\n')}
          aria-label={rest.map(label => label.name).join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/** The nine colours, as a row of swatches. Used wherever a tag is written. */
export function TaskLabelColorPicker({
  value,
  onChange,
  disabled = false
}: {
  value: TeamTaskLabelColor;
  onChange: (color: TeamTaskLabelColor) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    /* The inventory's picto group (070): one colour of nine, each a swatch named by its hint. */
    <RadioGroup<TeamTaskLabelColor>
      variant="pictos"
      className="team-task-label-colors"
      label={t('teamTaskTagColorLabel')}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={TEAM_TASK_LABEL_COLORS.map(color => ({
        value: color,
        label: t(COLOR_NAME[color]),
        icon: <span className="team-task-label-swatch" data-color={color} aria-hidden="true" />
      }))}
    />
  );
}
