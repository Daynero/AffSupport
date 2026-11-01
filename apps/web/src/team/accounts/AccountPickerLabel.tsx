import { sortTeamTaskLabels, type TeamTaskLabelRef } from '@video-compressor/shared';
import { TaskLabelChip } from '../labels/TaskLabelChip';

/** Picker rows show the existing RK labels without introducing nested actions. */
export function AccountPickerLabel({
  name,
  labels
}: {
  name: string;
  labels: readonly TeamTaskLabelRef[];
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <strong>{name}</strong>
      {sortTeamTaskLabels(labels).map(label => (
        <TaskLabelChip key={label.id} label={label} />
      ))}
    </span>
  );
}
