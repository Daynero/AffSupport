/**
 * The tag dictionary, in space settings (018).
 *
 * A space's tags are made here and nowhere else: the task editor hangs them,
 * the board filters by them, but the list of what exists is one thing a team
 * agrees on, and a picker that can also invent a tag is how a dictionary ends
 * up holding "UGC", "ugc " and "UCG".
 *
 * The panel is a list to be scanned, like the accounts table: one row per tag,
 * its colour carried by the chip itself, how many tasks carry it beside it,
 * and the two row actions quiet until the row is reached.
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  TEAM_TASK_LABEL_MAX,
  TEAM_TASK_LABEL_NAME_MAX,
  nextTeamTaskLabelColor,
  normalizeTeamTaskLabelName,
  type TeamLabelScope,
  type TeamTaskLabel,
  type TeamTaskLabelColor
} from '@video-compressor/shared';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { agentCountKey, taskCountKey } from '../accounts/plural';
import { TaskLabelChip, TaskLabelColorPicker } from './TaskLabelChip';
import { useTaskLabels, type TaskLabelsClient } from './useTaskLabels';

export type TaskLabelsSectionClient = TaskLabelsClient;

/**
 * A duplicate name is the one failure this panel produces in normal use, and
 * the shared mapping's sentence for it is about files. Said in the tags' own
 * words here, as the accounts list says it in accounts'.
 */
function nameErrorKey(error: unknown): TranslationKey | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (code === 'NAME_CONFLICT') return 'teamTaskTagNameConflict';
    if (code === 'INVALID_INPUT') return 'teamTaskTagNameInvalid';
  }
  return null;
}

/** The row being renamed, with the values typed so far. */
type Editing = { id: string; name: string; color: TeamTaskLabelColor };

export function TaskLabelsSection({
  teamId,
  client,
  revision = 0,
  scope = 'task'
}: {
  teamId: string;
  client?: TaskLabelsSectionClient;
  revision?: number;
  /** Which set this panel keeps: the tags on tasks, or the tags on agents. */
  scope?: TeamLabelScope;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const canEdit = can('edit');
  const labels = useTaskLabels({ teamId, revision, scope, client });
  const agents = scope === 'agent';
  const [name, setName] = useState('');
  const [color, setColor] = useState<TeamTaskLabelColor>('purple');
  /** Until someone picks a colour, the form offers the least-used one. */
  const [colorChosen, setColorChosen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<TeamTaskLabel | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const confirmId = useId();
  const full = labels.labels.length >= TEAM_TASK_LABEL_MAX;

  useEffect(() => {
    if (!colorChosen) setColor(nextTeamTaskLabelColor(labels.labels));
  }, [colorChosen, labels.labels]);

  const fail = (cause: unknown) => {
    const key = nameErrorKey(cause);
    push({ tone: 'error', text: key ? t(key) : teamErrorMessageFor(cause, t) });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const clean = normalizeTeamTaskLabelName(name);
    if (!clean) {
      push({ tone: 'error', text: t('teamTaskTagNameInvalid') });
      return;
    }
    setBusy(true);
    try {
      await labels.create(clean, color);
      // The field empties and keeps focus: a dictionary is written in one
      // sitting, several tags at a time.
      setName('');
      setColorChosen(false);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const clean = normalizeTeamTaskLabelName(editing.name);
    if (!clean) {
      push({ tone: 'error', text: t('teamTaskTagNameInvalid') });
      return;
    }
    setBusy(true);
    try {
      await labels.update(editing.id, clean, editing.color);
      setEditing(null);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (label: TeamTaskLabel) => {
    setBusy(true);
    try {
      await labels.remove(label.id);
      setConfirming(null);
      push({ tone: 'info', text: t('teamTaskTagDeleted', { name: label.name }) });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-panel team-task-labels" aria-labelledby={titleId}>
      <h2 id={titleId}>{t(agents ? 'teamAgentTagsTitle' : 'teamTaskTagsTitle')}</h2>
      <p>{t(agents ? 'teamAgentTagsDescription' : 'teamTaskTagsDescription')}</p>

      {canEdit && (
        <form className="team-task-labels-create" onSubmit={event => void create(event)}>
          <label className="team-task-labels-name">
            <span>{t('teamTaskTagName')}</span>
            <input
              value={name}
              maxLength={TEAM_TASK_LABEL_NAME_MAX}
              placeholder={t(agents ? 'teamAgentTagNamePlaceholder' : 'teamTaskTagNamePlaceholder')}
              disabled={busy || full}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <TaskLabelColorPicker
            value={color}
            disabled={busy || full}
            onChange={next => {
              setColor(next);
              setColorChosen(true);
            }}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={full}>
            <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamTaskTagAdd')}
          </Button>
        </form>
      )}
      {/* Said where it becomes true, not as a warning nobody near the limit
          needs to read. */}
      {full && <p className="team-inline-error">{t('teamTaskTagsFull')}</p>}

      {labels.loading && labels.labels.length === 0 && (
        <p aria-live="polite">{t('teamTaskTagsLoading')}</p>
      )}
      {/* An empty dictionary says one thing, calmly: how to start it. A red
          line over a panel that has nothing in it yet is noise — and if the
          read genuinely failed, the very next press says so in a toast, with
          the server's own reason. A list already on screen keeps a quiet word
          that it may be out of date. */}
      {!labels.loading && labels.labels.length === 0 && (
        <p className="team-task-labels-empty">
          {t(agents ? 'teamAgentTagsEmpty' : 'teamTaskTagsEmpty')}
        </p>
      )}
      {labels.error && labels.labels.length > 0 && (
        <p className="team-task-labels-stale" role="status">
          {t('teamTaskTagsLoadFailed')}
        </p>
      )}

      {labels.labels.length > 0 && (
        <ul className="team-task-labels-list">
          {labels.labels.map(label =>
            editing?.id === label.id ? (
              <li key={label.id} className="team-task-labels-row is-editing">
                <input
                  autoFocus
                  value={editing.name}
                  maxLength={TEAM_TASK_LABEL_NAME_MAX}
                  /* Named for the row it edits: eight fields all called
                     "Name" are eight identical announcements. */
                  aria-label={`${t('teamTaskTagName')}: ${label.name}`}
                  disabled={busy}
                  onChange={event => setEditing({ ...editing, name: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveEdit();
                    }
                    if (event.key === 'Escape') {
                      // Ours, not the dialog's: the field closes, settings stay.
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
                <TaskLabelColorPicker
                  value={editing.color}
                  disabled={busy}
                  onChange={next => setEditing({ ...editing, color: next })}
                />
                <Button
                  type="button"
                  variant="primary"
                  loading={busy}
                  onClick={() => void saveEdit()}
                >
                  {t('teamAccountsSave')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  {t('teamCancel')}
                </Button>
              </li>
            ) : (
              <li key={label.id} className="team-task-labels-row">
                <TaskLabelChip label={label} />
                {/* The count says what it counts: tasks in one set, agents in
                    the other. */}
                <span className="team-task-labels-count">
                  {t(
                    agents
                      ? agentCountKey(language, label.taskCount)
                      : taskCountKey(language, label.taskCount),
                    { count: label.taskCount }
                  )}
                </span>
                {canEdit && (
                  <>
                    <IconButton
                      type="button"
                      label={`${t('teamTaskTagRename')}: ${label.name}`}
                      className="team-task-labels-action"
                      disabled={busy}
                      onClick={() =>
                        setEditing({ id: label.id, name: label.name, color: label.color })
                      }
                    >
                      <Pencil size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      type="button"
                      label={`${t('teamTaskTagDelete')}: ${label.name}`}
                      className="team-task-labels-action is-danger"
                      disabled={busy}
                      onClick={() => setConfirming(label)}
                    >
                      <Trash2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    </IconButton>
                  </>
                )}
              </li>
            )
          )}
        </ul>
      )}

      {confirming && (
        <Modal labelledBy={confirmId} size="sm" onClose={() => setConfirming(null)}>
          <h3 id={confirmId}>{t('teamTaskTagDeleteTitle', { name: confirming.name })}</h3>
          {/* Names the consequence rather than asking "are you sure?": the tag
              leaves the tasks carrying it, and those tasks stay. */}
          <p>
            {confirming.taskCount > 0
              ? t('teamTaskTagDeleteBodyUsed', {
                  count: t(
                    agents
                      ? agentCountKey(language, confirming.taskCount)
                      : taskCountKey(language, confirming.taskCount),
                    { count: confirming.taskCount }
                  )
                })
              : t('teamTaskTagDeleteBody')}
          </p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() => void remove(confirming)}
            >
              {t('teamTaskTagDelete')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
