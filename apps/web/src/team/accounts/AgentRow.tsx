/**
 * One agent under an account, in whichever of its states it is in.
 *
 * Reading it: the agent as `v31-434` (a press copies the full id), the runs on
 * it — one line each, with a pencil and a bin — and a plus to write another.
 * A free row (no runs) carries the green wash and nothing else says "free" a
 * second time.
 *
 * Being corrected: the same row. The id is edited as a field in place of the
 * chip; a run is edited as a field in place of its line; a new run is a field
 * under the last line. Enter saves, Escape lets go.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Eraser, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  normalizeTeamAgentId,
  normalizeTeamAgentNote,
  teamAgentLabel,
  type TeamAccountAgentSummary,
  type TeamAgentRun
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type Language, type TranslationKey } from '../../i18n';
import { copyText } from '../../two-factor/clipboard';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';

const ICON = 18;

/** "2 tasks" — three forms in Ukrainian, two in English. */
export function taskCountKey(language: Language, count: number): TranslationKey {
  const category = new Intl.PluralRules(language === 'uk' ? 'uk-UA' : 'en-US').select(count);
  if (category === 'one') return 'teamAgentTasksOne';
  if (category === 'few') return 'teamAgentTasksFew';
  return 'teamAgentTasksMany';
}

/** The codes the row explains itself; everything else goes through the shared copy. */
function agentErrorKey(error: unknown): TranslationKey {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (code === 'NAME_CONFLICT') return 'teamAgentConflict';
    if (code === 'INVALID_INPUT') return 'teamAgentIdInvalid';
  }
  return 'teamAccountsSaveFailed';
}

/** The full account and id, for a tooltip: what the chip abbreviates. */
export function agentTooltip(
  accountName: string,
  agent: Pick<TeamAccountAgentSummary, 'agentId' | 'runs'>,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string {
  const lines = [
    t('teamAgentTooltipAccount', { name: accountName }),
    t('teamAgentTooltipId', { id: agent.agentId })
  ];
  for (const run of agent.runs) lines.push(t('teamAgentTooltipRun', { note: run.note }));
  if (agent.runs.length === 0) lines.push(t('teamAgentFree'));
  return lines.join('\n');
}

/** Which run of the row is being written, if any: a new one, or one by id. */
export type RunEditing = { runId: string | null } | null;

export function AgentRow({
  agent,
  accountName,
  canEdit,
  pending = false,
  tasksHref,
  runEditing = null,
  hold = false,
  onDirtyChange,
  onRunEditingChange,
  onEdit,
  onAddRun,
  onUpdateRun,
  onDeleteRun,
  onRelease,
  onDelete
}: {
  agent: TeamAccountAgentSummary;
  accountName: string;
  canEdit: boolean;
  /** A write on this agent is in flight elsewhere (an undo); the row waits. */
  pending?: boolean;
  /** The task list narrowed to this agent, shown when any task carries its tag. */
  tasksHref: string;
  runEditing?: RunEditing;
  hold?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onRunEditingChange: (editing: RunEditing) => void;
  onEdit: () => void;
  onAddRun: (note: string) => Promise<void>;
  onUpdateRun: (runId: string, note: string) => Promise<void>;
  onDeleteRun: (run: TeamAgentRun) => Promise<void>;
  onRelease: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = agent.runs.length === 0;
  const tag = teamAgentLabel(accountName, agent.agentId);
  const waiting = busy || pending;
  /** Every row's buttons say which agent they act on, not just what they do. */
  const named = (key: TranslationKey) => `${t(key)} ${tag}`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * The clipboard write happens inside the click, synchronously — Safari
   * refuses one issued after an await. A failed copy never looks like a
   * success: the full id is shown instead, so it can still be selected.
   */
  const copyId = () => {
    void copyText(agent.agentId).then(ok => {
      if (ok) {
        setCopied(true);
        return;
      }
      setRevealed(true);
      push({ tone: 'error', text: t('teamAgentCopyFailed') });
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const editingNew = runEditing !== null && runEditing.runId === null;
  /** The plus that writes another run — one per row, at the end of the last line. */
  const addRunButton = (
    <IconButton
      label={named('teamAgentRunAdd')}
      className="team-agent-action is-small team-agent-run-add"
      disabled={waiting || editingNew}
      onClick={() => onRunEditingChange({ runId: null })}
    >
      <Plus size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </IconButton>
  );

  return (
    <li
      className={`team-agent-row${free ? ' is-free' : ''}${pending ? ' is-pending' : ''}`}
      data-agent-row-id={agent.id}
      data-free={free ? 'true' : 'false'}
      aria-busy={pending || undefined}
    >
      <span className="team-agent-rail" aria-hidden="true" />
      {/* The agent's identity is `v31-434` — the account and the tail of the
          id, the same chip a task shows — so an ad account never reads like a
          second social account, however its id happens to end. Pressing it
          copies the full id; the tooltip spells both out. */}
      <div className="team-agent-id">
        <button
          type="button"
          className={`team-agent-tag${free ? ' is-free' : ''}${copied ? ' is-copied' : ''}${revealed ? ' is-revealed' : ''}`}
          title={agentTooltip(accountName, agent, t)}
          aria-label={named('teamAgentCopyId')}
          onClick={copyId}
        >
          <span className="team-task-agent-chip-dot" aria-hidden="true" />
          <span className="team-agent-tag-text">{revealed ? agent.agentId : tag}</span>
          <span className="team-agent-id-mark" aria-hidden="true">
            {copied ? (
              <Check size={13} strokeWidth={ICON_STROKE} />
            ) : (
              <Copy size={13} strokeWidth={ICON_STROKE} />
            )}
          </span>
        </button>
      </div>

      {/* The runs: one line each. A line being corrected is a field; a new
          run is a field under the last line. The plus sits at the end of the
          last line, so a row with one run stays one line tall. */}
      <div className="team-agent-runs">
        {agent.runs.length === 0 && !editingNew && (
          <div className="team-agent-run is-empty">
            <span className="team-agent-runs-empty">{t('teamAgentFree')}</span>
            {canEdit && addRunButton}
          </div>
        )}
        {agent.runs.map((item, index) =>
          runEditing?.runId === item.id ? (
            <RunField
              key={item.id}
              initial={item.note}
              hold={hold}
              onDirtyChange={onDirtyChange}
              onSave={note => onUpdateRun(item.id, note)}
              onCancel={() => onRunEditingChange(null)}
              onSaved={() => onRunEditingChange(null)}
            />
          ) : (
            <div key={item.id} className="team-agent-run" data-run-id={item.id}>
              <span className="team-agent-run-text">{item.note}</span>
              {canEdit && index === agent.runs.length - 1 && !editingNew && addRunButton}
              {canEdit && (
                <span className="team-agent-run-actions">
                  <IconButton
                    label={`${t('teamAgentRunEdit')}: ${item.note}`}
                    className="team-agent-action is-small"
                    disabled={waiting}
                    onClick={() => onRunEditingChange({ runId: item.id })}
                  >
                    <Pencil size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`${t('teamAgentRunDelete')}: ${item.note}`}
                    className="team-agent-action is-small is-danger"
                    disabled={waiting}
                    onClick={() => void run(() => onDeleteRun(item))}
                  >
                    <Trash2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                </span>
              )}
            </div>
          )
        )}
        {editingNew && (
          <RunField
            initial=""
            hold={hold}
            onDirtyChange={onDirtyChange}
            onSave={onAddRun}
            onCancel={() => onRunEditingChange(null)}
            onSaved={() => onRunEditingChange(null)}
          />
        )}
      </div>

      {/* How many tasks are about this agent, and the way to them: a real
          link into the task list, already narrowed. Its own column, so the
          numbers line up down the card. */}
      <div className="team-agent-tasks">
        {agent.taskCount > 0 ? (
          <a
            className="team-agent-tasks-link"
            href={tasksHref}
            title={t('teamAgentTasksLinkTitle')}
            onClick={event => internalLink(event, tasksHref)}
          >
            {t(taskCountKey(language, agent.taskCount), { count: agent.taskCount })}
          </a>
        ) : (
          <span className="team-agent-tasks-none" aria-hidden="true">
            —
          </span>
        )}
      </div>
      <div className="team-agent-actions">
        {canEdit && (
          <>
            {!free && (
              <IconButton
                label={named('teamAgentRelease')}
                className="team-agent-action is-release"
                disabled={waiting}
                onClick={() => void run(onRelease)}
              >
                <Eraser size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              label={named('teamAgentEdit')}
              className="team-agent-action"
              disabled={waiting}
              onClick={onEdit}
            >
              <Pencil size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={named('teamAgentDelete')}
              className="team-agent-action is-danger"
              disabled={waiting}
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          </>
        )}
      </div>

      {/* Focus starts on Cancel: Enter on the trash and Enter again must not
          be a deletion with no pause in between. */}
      {confirming && (
        <Modal
          labelledBy={titleId}
          onClose={() => setConfirming(false)}
          size="sm"
          initialFocus="[data-cancel]"
        >
          <h3 id={titleId}>{t('teamAgentDeleteTitle', { tag })}</h3>
          <p>{t('teamAgentDeleteBody', { id: agent.agentId })}</p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await onDelete();
                  setConfirming(false);
                })
              }
            >
              {t('teamAgentDelete')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-cancel="true"
              onClick={() => setConfirming(false)}
            >
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </li>
  );
}

/** A run being written or corrected, in place of its line. */
export function RunField({
  initial,
  hold,
  onDirtyChange,
  onSave,
  onCancel,
  onSaved
}: {
  initial: string;
  hold: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (note: string) => Promise<void>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState(initial);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  useEffect(() => {
    if (hold) field.current?.focus();
  }, [hold]);
  const dirty = note !== initial;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const submit = async () => {
    const clean = normalizeTeamAgentNote(note);
    if (!clean) {
      setError('teamAgentNoteInvalid');
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
      onSaved();
    } catch {
      setError('teamAccountsSaveFailed');
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
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="team-agent-run is-editing">
      <EditField
        inputRef={field}
        className="team-agent-run-field"
        value={note}
        label={t('teamAgentNotePlaceholder')}
        onChange={value => {
          setNote(value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="team-agent-run-actions is-editing">
        <IconButton
          label={t('teamAccountsSave')}
          className="team-agent-action is-small is-confirm"
          disabled={saving}
          onClick={() => void submit()}
        >
          <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('teamCancel')}
          className="team-agent-action is-small is-reject"
          onClick={onCancel}
        >
          <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </span>
      {error && (
        <span className="team-accounts-edit-error" role="alert">
          {t(error)}
        </span>
      )}
      {!error && hold && (
        <span className="team-accounts-edit-hint" role="status">
          {t('teamAccountsFinishEditing')}
        </span>
      )}
    </div>
  );
}

/**
 * The editor for an agent's id — a new agent (with an optional first run), or
 * an existing id being corrected.
 */
export function AgentEditRow({
  agent = null,
  hold = false,
  onDirtyChange,
  onSave,
  onCancel
}: {
  /** The agent being corrected; null when adding one. */
  agent?: TeamAccountAgentSummary | null;
  /** Another editor was asked for while this one has unsaved typing. */
  hold?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (value: { agentId: string; note: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState(agent?.agentId ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  const adding = agent === null;

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  // A refused switch brings the caret back here, next to the hint that says why.
  useEffect(() => {
    if (hold) firstField.current?.focus();
  }, [hold]);

  // Dirty means "differs from what was there": a correction abandoned unchanged
  // is not typing anyone would miss.
  const dirty = agentId !== (agent?.agentId ?? '') || note !== '';
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const submit = async () => {
    const cleanId = normalizeTeamAgentId(agentId);
    if (!cleanId) {
      setError('teamAgentIdInvalid');
      return;
    }
    const cleanNote = normalizeTeamAgentNote(note);
    if (cleanNote === undefined) {
      setError('teamAgentNoteInvalid');
      return;
    }
    setSaving(true);
    try {
      await onSave({ agentId: cleanId, note: cleanNote });
    } catch (cause) {
      // Typed values survive a refusal; the message names what was refused.
      setError(agentErrorKey(cause));
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
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <li className="team-agent-row is-editing">
      <span className="team-agent-rail" aria-hidden="true" />
      <div className="team-agent-edit-fields">
        <EditField
          inputRef={firstField}
          className="team-agent-edit-id"
          value={agentId}
          label={t('teamAgentIdPlaceholder')}
          onChange={value => {
            setAgentId(value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        {/* A first run can be written with the id; later runs have their own
            plus on the row. */}
        {adding && (
          <EditField
            className="team-agent-edit-note"
            value={note}
            label={t('teamAgentNotePlaceholder')}
            onChange={value => {
              setNote(value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
          />
        )}
        {error && (
          <span className="team-accounts-edit-error" role="alert">
            {t(error)}
          </span>
        )}
        {!error && hold && (
          <span className="team-accounts-edit-hint" role="status">
            {t('teamAccountsFinishEditing')}
          </span>
        )}
      </div>
      <div className="team-agent-actions">
        <IconButton
          label={t('teamAccountsSave')}
          className="team-agent-action is-confirm"
          disabled={saving}
          onClick={() => void submit()}
        >
          <Check size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('teamCancel')}
          className="team-agent-action is-reject"
          onClick={onCancel}
        >
          <X size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
}

export function EditField({
  value,
  label,
  onChange,
  onKeyDown,
  inputRef,
  className = ''
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`team-accounts-field ${className}`.trim()}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        placeholder={label}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {/* Out of the tab order: Tab from the id should land in the note, not
          on the clear mark beside it. The mouse still reaches it. */}
      {value !== '' && (
        <IconButton label={t('teamAccountsClearField')} tabIndex={-1} onClick={() => onChange('')}>
          <X size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
