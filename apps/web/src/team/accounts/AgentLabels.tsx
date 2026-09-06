/**
 * The tags an agent carries (019), beside its name.
 *
 * The same chips a task carries and the same popover that hangs them, from the
 * *agent* half of the space's dictionary — `#2`, `#5`, whatever the team calls
 * its batches. They are what the "Copy with IDs" list groups by, so a tag here
 * is not decoration: it is the heading somebody will paste into a payment run.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  sortTeamTaskLabels,
  type TeamTaskLabel,
  type TeamTaskLabelRef
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskLabelChip } from '../labels/TaskLabelChip';
import { TaskLabelMenu } from '../labels/TaskLabelMenu';

export function AgentLabels({
  labels,
  available,
  canEdit,
  busy = false,
  agentLabel,
  onToggle
}: {
  /** The tags this agent carries. */
  labels: readonly TeamTaskLabelRef[];
  /** The agent half of the space's dictionary. */
  available: readonly TeamTaskLabel[];
  canEdit: boolean;
  busy?: boolean;
  /** The agent's name, so the add button says which row it belongs to. */
  agentLabel: string;
  onToggle: (label: TeamTaskLabelRef, next: boolean) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const attached = new Set(labels.map(label => label.id));

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  // Nothing at all for a viewer with nothing to show: an empty row of buttons
  // down the list is work waiting for someone who cannot do it.
  if (!canEdit && labels.length === 0) return null;

  return (
    <div ref={root} className="team-agent-labels">
      {sortTeamTaskLabels(labels).map(label => (
        <TaskLabelChip
          key={label.id}
          label={label}
          disabled={busy || !canEdit}
          onRemove={canEdit ? () => onToggle(label, false) : undefined}
        />
      ))}
      {canEdit && (
        <button
          ref={trigger}
          type="button"
          className="team-agent-labels-add"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${t('teamAgentLabelAdd')} ${agentLabel}`}
          title={t('teamAgentLabelAdd')}
          disabled={busy}
          onClick={() => setOpen(current => !current)}
        >
          <Plus size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      )}
      {open && canEdit && (
        <TaskLabelMenu
          labels={available}
          selectedIds={attached}
          disabled={busy}
          ariaLabel={t('teamAgentLabelsLabel')}
          emptyText={t('teamAgentLabelsNoneYet')}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}
