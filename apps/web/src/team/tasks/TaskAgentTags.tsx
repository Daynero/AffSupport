/**
 * The tags a task carries (017): `v31-434`, one per agent, each showing live
 * whether that agent is free.
 *
 * On a card they are read-only chips. In the editor a chip opens a panel
 * under the row: the runs on that agent, one line each with a pencil and a
 * bin, a plus to write another (prefilled with the task's title, since that
 * is usually what launched), and a way to take the tag off the task. Writing
 * a run is deliberately a press and not automatic: tasks are also edits and
 * re-cuts, and only the person closing one knows which it was.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  TEAM_AGENT_NOTE_MAX,
  isTeamAgentFree,
  normalizeTeamAgentNote,
  sortTeamTaskAgentTags,
  teamAgentRunsSummary,
  teamTaskAgentTagLabel,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamTaskAgentTag
} from '@video-compressor/shared';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { TaskAccountPicker, type TaskAccountPickerClient } from './TaskAccountPicker';

export interface TaskAgentTagsClient extends TaskAccountPickerClient {
  attachTaskAgent(input: {
    teamId: string;
    taskId: string;
    agentRowId: string;
  }): Promise<TeamTaskAgentTag[]>;
  detachTaskAgent(input: {
    teamId: string;
    taskId: string;
    agentRowId: string;
  }): Promise<TeamTaskAgentTag[]>;
  addAgentRun(input: {
    teamId: string;
    agentRowId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary>;
  updateAgentRun(input: {
    teamId: string;
    runId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary>;
  deleteAgentRun(input: { teamId: string; runId: string }): Promise<TeamAccountAgentSummary>;
}

/** What a chip says on hover: the account, the full id, the runs. */
function chipTooltip(
  tag: TeamTaskAgentTag,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string {
  const lines = [
    t('teamAgentTooltipAccount', { name: tag.accountName }),
    t('teamAgentTooltipId', { id: tag.agentId })
  ];
  for (const run of tag.runs) lines.push(t('teamAgentTooltipRun', { note: run.note }));
  if (tag.runs.length === 0) lines.push(t('teamAgentFree'));
  return lines.join('\n');
}

/** A tag as a chip. With `onSelect` it is the button that opens the panel. */
function TagChip({
  tag,
  selected = false,
  onSelect
}: {
  tag: TeamTaskAgentTag;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { t } = useI18n();
  const free = isTeamAgentFree(tag);
  const label = teamTaskAgentTagLabel(tag);
  const title = chipTooltip(tag, t);
  const className = `team-task-agent-chip${free ? ' is-free' : ''}${selected ? ' is-selected' : ''}`;
  if (!onSelect) {
    return (
      <span className={className} title={title}>
        <span className="team-task-agent-chip-dot" aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-pressed={selected}
      aria-label={`${label} — ${free ? t('teamAgentFree') : teamAgentRunsSummary(tag)}`}
      onClick={onSelect}
    >
      <span className="team-task-agent-chip-dot" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * The read-only chips on a card, inline with the status; nothing when there
 * are none. Past `limit` the rest fold into one "+N" chip whose tooltip lists
 * them, so a task on five accounts keeps a one-line strip.
 */
export function TaskAgentTagList({ tags, limit }: { tags: TeamTaskAgentTag[]; limit?: number }) {
  const { t } = useI18n();
  if (tags.length === 0) return null;
  const sorted = sortTeamTaskAgentTags(tags);
  const shown = limit !== undefined && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  const rest = sorted.slice(shown.length);
  return (
    <div className="team-task-agent-tags" aria-label={t('teamTaskAccountsLabel')}>
      {shown.map(tag => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest.length > 0 && (
        <span
          className="team-task-agent-chip is-more"
          title={rest
            .map(tag => `${teamTaskAgentTagLabel(tag)}\n${chipTooltip(tag, t)}`)
            .join('\n\n')}
          aria-label={rest.map(teamTaskAgentTagLabel).join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/** Which run of the open chip is being written: a new one, or one by id. */
type RunEditing = { runId: string | null } | null;

/** The editor's row: chips, the add button, and the panel for the open chip. */
export function TaskAgentTagsEditor({
  teamId,
  taskId,
  taskTitle,
  tags,
  canEdit,
  client,
  onTagsChange
}: {
  teamId: string;
  taskId: string;
  /** Prefills a run written onto an agent from this task. */
  taskTitle: string;
  tags: TeamTaskAgentTag[];
  canEdit: boolean;
  client: TaskAgentTagsClient;
  onTagsChange: (tags: TeamTaskAgentTag[]) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const labelId = useId();
  const [picking, setPicking] = useState(false);
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  const [runEditing, setRunEditing] = useState<RunEditing>(null);
  const [busy, setBusy] = useState(false);
  const addRunButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const sorted = sortTeamTaskAgentTags(tags);
  const openTag = tags.find(tag => tag.id === openTagId) ?? null;

  const fail = (cause: unknown) => push({ tone: 'error', text: teamErrorMessageFor(cause, t) });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  // One call per agent, and the list follows each: a failure midway leaves
  // what did land on screen rather than nothing.
  const addAgents = (chosen: { agent: TeamAccountAgentSummary; account: TeamAccountSummary }[]) =>
    run(async () => {
      for (const { agent } of chosen) {
        onTagsChange(await client.attachTaskAgent({ teamId, taskId, agentRowId: agent.id }));
      }
    });

  const detach = (tag: TeamTaskAgentTag) =>
    run(async () => {
      const next = await client.detachTaskAgent({ teamId, taskId, agentRowId: tag.agentRowId });
      onTagsChange(next);
      setOpenTagId(null);
      // The panel and its × are gone; the add button is the row's one fixed point.
      window.requestAnimationFrame(() => addButton.current?.focus());
      push({
        tone: 'info',
        text: t('teamTaskAccountRemoved', { tag: teamTaskAgentTagLabel(tag) }),
        action: {
          label: t('teamUndo'),
          run: async () => {
            try {
              onTagsChange(
                await client.attachTaskAgent({ teamId, taskId, agentRowId: tag.agentRowId })
              );
            } catch (cause) {
              fail(cause);
            }
          }
        }
      });
    });

  /** The agent came back from a run write; every tag pointing at it follows. */
  const applyAgent = (updated: TeamAccountAgentSummary) =>
    onTagsChange(
      tags.map(item => (item.agentRowId === updated.id ? { ...item, runs: updated.runs } : item))
    );

  /** Leaving the run field hands focus back to the plus that opened it. */
  const stopEditingRun = () => {
    setRunEditing(null);
    window.requestAnimationFrame(() => addRunButton.current?.focus());
  };

  const saveRun = async (tag: TeamTaskAgentTag, runId: string | null, note: string) => {
    const updated =
      runId === null
        ? await client.addAgentRun({ teamId, agentRowId: tag.agentRowId, note })
        : await client.updateAgentRun({ teamId, runId, note });
    applyAgent(updated);
    push({ tone: 'success', text: t('teamTaskRunWritten', { tag: teamTaskAgentTagLabel(tag) }) });
  };

  const deleteRun = (tag: TeamTaskAgentTag, runId: string, note: string) =>
    run(async () => {
      applyAgent(await client.deleteAgentRun({ teamId, runId }));
      push({
        tone: 'info',
        text: t('teamAccountsToastRunDeleted', { note }),
        action: {
          label: t('teamUndo'),
          run: async () => {
            try {
              applyAgent(await client.addAgentRun({ teamId, agentRowId: tag.agentRowId, note }));
            } catch (cause) {
              fail(cause);
            }
          }
        }
      });
    });

  const select = (tag: TeamTaskAgentTag) => {
    setRunEditing(null);
    setOpenTagId(current => (current === tag.id ? null : tag.id));
  };

  const attachedIds = new Set(tags.map(tag => tag.agentRowId));

  return (
    <div className="team-task-accounts" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="team-task-accounts-label">
        {t('teamTaskAccountsLabel')}
      </span>
      <div className="team-task-agent-tags is-editing">
        {sorted.map(tag => (
          <TagChip
            key={tag.id}
            tag={tag}
            selected={tag.id === openTagId}
            onSelect={canEdit ? () => select(tag) : undefined}
          />
        ))}
        {/* Nothing is said when nothing is chosen: "+ Account" beside an
            empty row already says both that it is empty and what to do. */}
        {canEdit && (
          <button
            ref={addButton}
            type="button"
            className="team-task-account-add"
            disabled={busy}
            onClick={() => setPicking(true)}
          >
            <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamTaskAccountAdd')}
          </button>
        )}
      </div>

      {openTag && canEdit && (
        <div
          className="team-task-agent-panel"
          role="region"
          aria-label={teamTaskAgentTagLabel(openTag)}
        >
          {/* Named, so the panel says which chip it belongs to before it says
              anything about it; the × takes the tag off the task. */}
          <div className="team-task-agent-panel-head">
            <span
              className={`team-task-agent-chip-dot${isTeamAgentFree(openTag) ? ' is-free' : ''}`}
              aria-hidden="true"
            />
            <strong className="team-task-agent-panel-tag">{teamTaskAgentTagLabel(openTag)}</strong>
            <span className="team-task-agent-panel-state">
              {isTeamAgentFree(openTag) ? t('teamTaskAgentIsFree') : t('teamTaskAgentRuns')}
            </span>
            <IconButton
              type="button"
              label={t('teamTaskAccountRemove')}
              className="team-task-agent-remove"
              disabled={busy}
              onClick={() => void detach(openTag)}
            >
              <X size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          </div>

          <ul className="team-task-agent-runs">
            {openTag.runs.map(item =>
              runEditing?.runId === item.id ? (
                <li key={item.id} className="team-task-agent-run is-editing">
                  <RunField
                    initial={item.note}
                    onSave={note => saveRun(openTag, item.id, note)}
                    onDone={stopEditingRun}
                  />
                </li>
              ) : (
                <li key={item.id} className="team-task-agent-run">
                  <span className="team-task-agent-run-text">{item.note}</span>
                  <IconButton
                    type="button"
                    label={`${t('teamAgentRunEdit')}: ${item.note}`}
                    className="team-task-agent-run-action"
                    disabled={busy}
                    onClick={() => setRunEditing({ runId: item.id })}
                  >
                    <Pencil size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    type="button"
                    label={`${t('teamAgentRunDelete')}: ${item.note}`}
                    className="team-task-agent-run-action is-danger"
                    disabled={busy}
                    onClick={() => void deleteRun(openTag, item.id, item.note)}
                  >
                    <Trash2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                </li>
              )
            )}
            {runEditing !== null && runEditing.runId === null && (
              <li className="team-task-agent-run is-editing">
                <RunField
                  initial={taskTitle}
                  onSave={note => saveRun(openTag, null, note)}
                  onDone={stopEditingRun}
                />
              </li>
            )}
          </ul>
          {!(runEditing !== null && runEditing.runId === null) && (
            <button
              ref={addRunButton}
              type="button"
              className="team-task-agent-run-add"
              disabled={busy}
              onClick={() => setRunEditing({ runId: null })}
            >
              <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('teamTaskWriteRun')}
            </button>
          )}
        </div>
      )}

      {picking && (
        <TaskAccountPicker
          teamId={teamId}
          client={client}
          attachedAgentRowIds={attachedIds}
          onAdd={chosen => void addAgents(chosen)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** A run being written or corrected, inside the panel. */
function RunField({
  initial,
  onSave,
  onDone
}: {
  initial: string;
  onSave: (note: string) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [note, setNote] = useState(initial);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const submit = async () => {
    const clean = normalizeTeamAgentNote(note);
    if (!clean) {
      push({ tone: 'error', text: t('teamAgentNoteInvalid') });
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
      onDone();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
    if (event.key === 'Escape') {
      // Ours, not the dialog's: the field closes, the editor stays.
      event.preventDefault();
      event.stopPropagation();
      onDone();
    }
  };

  return (
    <div className="team-task-agent-run-editor">
      <input
        ref={field}
        type="text"
        value={note}
        maxLength={TEAM_AGENT_NOTE_MAX}
        aria-label={t('teamTaskWriteRunLabel')}
        placeholder={t('teamAgentNotePlaceholder')}
        onChange={event => setNote(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button type="button" variant="primary" loading={saving} onClick={() => void submit()}>
        <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('teamTaskWriteRunSave')}
      </Button>
      <Button type="button" variant="ghost" onClick={onDone}>
        {t('teamCancel')}
      </Button>
    </div>
  );
}
