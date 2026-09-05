/**
 * One account and the agents inside it.
 *
 * The head row is the account: its name, how many agents it holds and how many
 * of them are free, and the three things you do to an account — put an agent
 * in it, rename it, delete it. It also folds: an account that is fully busy is
 * not one you are working in today, and folding it keeps the list to the ones
 * you are.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2, UserRound, X } from 'lucide-react';
import {
  countTeamAccounts,
  normalizeTeamAccountName,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamAgentRun
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type Language, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute } from '../routes';
import { AgentEditRow, AgentRow, EditField, taskCountKey } from './AgentRow';

const ICON = 18;

/** Ukrainian counts three ways; English two. One place decides which. */
export function agentCountKey(language: Language, count: number): TranslationKey {
  const category = new Intl.PluralRules(language === 'uk' ? 'uk-UA' : 'en-US').select(count);
  if (category === 'one') return 'teamAccountAgentsOne';
  if (category === 'few') return 'teamAccountAgentsFew';
  return 'teamAccountAgentsMany';
}

function nameErrorKey(error: unknown): TranslationKey {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (code === 'NAME_CONFLICT') return 'teamAccountNameConflict';
    if (code === 'INVALID_INPUT') return 'teamAccountNameInvalid';
  }
  return 'teamAccountsSaveFailed';
}

export type AgentEditing =
  | { kind: 'add' }
  | { kind: 'rename' }
  | { kind: 'edit'; agentRowId: string }
  /** A run on an agent: a new one (`runId: null`) or one by id. */
  | { kind: 'run'; agentRowId: string; runId: string | null }
  | null;

export function AccountGroup({
  teamId,
  account,
  /** The agents the filter left; the count in the head is of all of them. */
  visibleAgents,
  canEdit,
  collapsed,
  onCollapsedChange,
  editing,
  hold = false,
  pendingAgentIds,
  showFreeCount = true,
  onDirtyChange,
  onEditingChange,
  onRename,
  onDelete,
  onAddAgent,
  onUpdateAgent,
  onDeleteAgent,
  onAddRun,
  onUpdateRun,
  onDeleteRun,
  onRelease
}: {
  teamId: string;
  account: TeamAccountSummary;
  visibleAgents: TeamAccountAgentSummary[];
  canEdit: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  editing: AgentEditing;
  /** Another editor was asked for while this one has unsaved typing. */
  hold?: boolean;
  /** Agents with a write in flight elsewhere (an undo); their rows wait. */
  pendingAgentIds?: ReadonlySet<string>;
  /** Off while the list is already filtered to free agents, where it repeats the rows. */
  showFreeCount?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onEditingChange: (editing: AgentEditing) => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onAddAgent: (value: { agentId: string; note: string | null }) => Promise<void>;
  onUpdateAgent: (agent: TeamAccountAgentSummary, agentId: string) => Promise<void>;
  onDeleteAgent: (agent: TeamAccountAgentSummary) => Promise<void>;
  onAddRun: (agent: TeamAccountAgentSummary, note: string) => Promise<void>;
  onUpdateRun: (agent: TeamAccountAgentSummary, runId: string, note: string) => Promise<void>;
  onDeleteRun: (agent: TeamAccountAgentSummary, run: TeamAgentRun) => Promise<void>;
  onRelease: (agent: TeamAccountAgentSummary) => Promise<void>;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  const nameId = useId();
  // Renaming is an editor like any other, so it goes through the same
  // one-at-a-time gate as the agent rows.
  const renaming = editing?.kind === 'rename';
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const counts = countTeamAccounts([account]);
  const filteredOut = visibleAgents.length < counts.agents;
  const taskCount = account.agents.reduce((total, agent) => total + agent.taskCount, 0);
  const accountTasksHref = buildTeamRoute({
    spaceId: teamId,
    section: 'tasks',
    query: { accountId: account.id }
  });
  // Adding an agent opens the group: a row appearing inside a folded account
  // would be a row nobody can see.
  const open = !collapsed || editing?.kind === 'add';

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
      setConfirming(false);
      push({ tone: 'success', text: t('teamAccountsToastAccountDeleted') });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setDeleting(false);
    }
  };

  const agentsLabel = (count: number) => t(agentCountKey(language, count), { count });

  /**
   * Closing an editor hands focus back to the thing that opened it — the run
   * cell, the fold toggle, the add button — rather than dropping it on the
   * page. Queued a frame, because the target renders in place of the editor.
   */
  const root = useRef<HTMLElement>(null);
  const closeEditor = useCallback(
    (...focus: string[]) => {
      onEditingChange(null);
      // Tried in order, not as one comma-joined selector: `querySelector` on a
      // list returns the first match in *document* order, and the id button
      // comes before the run cell in a row — so the fallback always won.
      window.requestAnimationFrame(() => {
        for (const selector of focus) {
          const target = root.current?.querySelector<HTMLElement>(selector);
          if (target) {
            target.focus();
            return;
          }
        }
      });
    },
    [onEditingChange]
  );
  const rowFocus = (agentRowId: string) => [
    `[data-agent-row-id="${agentRowId}"] .team-agent-run-add`,
    `[data-agent-row-id="${agentRowId}"] .team-agent-tag`
  ];
  /** Back to the pencil that opened the rename, or the fold toggle for a viewer. */
  const HEAD_FOCUS = ['.team-account-actions .team-agent-action', '.team-account-toggle'];

  return (
    <section
      ref={root}
      className={`team-account${open ? '' : ' is-collapsed'}`}
      aria-labelledby={nameId}
      data-account-id={account.id}
    >
      {renaming ? (
        <AccountNameRow
          initialName={account.name}
          hold={hold}
          onDirtyChange={onDirtyChange}
          onCancel={() => closeEditor(...HEAD_FOCUS)}
          onSave={async name => {
            await onRename(name);
            closeEditor(...HEAD_FOCUS);
          }}
        />
      ) : (
        <div className="team-account-head">
          <div className="team-account-title">
            <button
              type="button"
              className="team-account-toggle"
              aria-expanded={open}
              aria-label={t(open ? 'teamAccountCollapse' : 'teamAccountExpand', {
                name: account.name
              })}
              onClick={() => onCollapsedChange(open)}
            >
              <ChevronDown size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            {/* The social account: an icon and the name. The icon is what
                tells it apart from the ad accounts listed under it. */}
            <span className="team-account-mark" aria-hidden="true">
              <UserRound size={ICON} strokeWidth={ICON_STROKE} />
            </span>
            <h3 className="team-account-name" id={nameId} title={account.name}>
              {account.name}
            </h3>
            <span className="team-account-meta">
              {counts.agents === 0 ? (
                <span>{t('teamAccountAgentsNone')}</span>
              ) : (
                <>
                  {/* Under a filter the head says how many of the agents are on
                      screen, so "3 agents" above two rows is not a puzzle. */}
                  <span className={filteredOut ? 'team-account-meta-shown' : undefined}>
                    {filteredOut
                      ? t('teamAccountAgentsShown', {
                          shown: visibleAgents.length,
                          count: counts.agents
                        })
                      : agentsLabel(counts.agents)}
                  </span>
                  {showFreeCount && counts.free > 0 && (
                    <span className="team-account-meta-free">
                      {t('teamAccountFreeCount', { count: counts.free })}
                    </span>
                  )}
                </>
              )}
              {taskCount > 0 && (
                <a
                  className="team-account-tasks-link"
                  href={accountTasksHref}
                  title={t('teamAccountTasksLinkTitle')}
                  onClick={event => internalLink(event, accountTasksHref)}
                >
                  {t(taskCountKey(language, taskCount), { count: taskCount })}
                </a>
              )}
            </span>
          </div>
          <div className="team-account-actions">
            {canEdit && (
              <>
                <button
                  type="button"
                  className="team-account-add-agent"
                  title={t('teamAgentAdd')}
                  aria-label={t('teamAgentAdd')}
                  onClick={() => onEditingChange({ kind: 'add' })}
                >
                  <Plus size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  <span className="team-account-add-agent-label">{t('teamAgentAddShort')}</span>
                </button>
                <IconButton
                  label={`${t('teamAccountRename')}: ${account.name}`}
                  className="team-agent-action"
                  onClick={() => onEditingChange({ kind: 'rename' })}
                >
                  <Pencil size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={`${t('teamAccountDelete')}: ${account.name}`}
                  className="team-agent-action is-danger"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
              </>
            )}
          </div>
        </div>
      )}

      {open && (
        <>
          {(visibleAgents.length > 0 || editing?.kind === 'add') && (
            <div className="team-account-columns" aria-hidden="true">
              <span />
              <span>{t('teamAccountColumnAgent')}</span>
              <span>{t('teamAccountColumnRun')}</span>
              <span>{t('teamAccountColumnTasks')}</span>
              <span />
            </div>
          )}
          {(visibleAgents.length > 0 || editing?.kind === 'add') && (
            <ul className="team-account-agents">
              {visibleAgents.map(agent =>
                editing?.kind === 'edit' && editing.agentRowId === agent.id ? (
                  <AgentEditRow
                    key={agent.id}
                    agent={agent}
                    hold={hold}
                    onDirtyChange={onDirtyChange}
                    onCancel={() => closeEditor(...rowFocus(agent.id))}
                    onSave={async value => {
                      await onUpdateAgent(agent, value.agentId);
                      closeEditor(...rowFocus(agent.id));
                    }}
                  />
                ) : (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    accountName={account.name}
                    canEdit={canEdit}
                    pending={pendingAgentIds?.has(agent.id) ?? false}
                    tasksHref={buildTeamRoute({
                      spaceId: teamId,
                      section: 'tasks',
                      query: { agentId: agent.id }
                    })}
                    runEditing={
                      editing?.kind === 'run' && editing.agentRowId === agent.id
                        ? { runId: editing.runId }
                        : null
                    }
                    hold={hold && editing?.kind === 'run' && editing.agentRowId === agent.id}
                    onDirtyChange={onDirtyChange}
                    onRunEditingChange={state =>
                      state
                        ? onEditingChange({ kind: 'run', agentRowId: agent.id, runId: state.runId })
                        : closeEditor(...rowFocus(agent.id))
                    }
                    onEdit={() => onEditingChange({ kind: 'edit', agentRowId: agent.id })}
                    onAddRun={note => onAddRun(agent, note)}
                    onUpdateRun={(runId, note) => onUpdateRun(agent, runId, note)}
                    onDeleteRun={run => onDeleteRun(agent, run)}
                    onRelease={() => onRelease(agent)}
                    onDelete={() => onDeleteAgent(agent)}
                  />
                )
              )}
              {/* Last, so a saved agent lands above the editor and the editor
                  stays where the caret is. Saving keeps it open, emptied, for
                  the next one — agents are put in several at a time, and
                  Escape is the way to stop. The toast is the receipt. */}
              {editing?.kind === 'add' && (
                <AgentEditRow
                  key={`add:${addedCount}`}
                  hold={hold}
                  onDirtyChange={onDirtyChange}
                  onCancel={() => closeEditor('.team-account-add-agent')}
                  onSave={async value => {
                    await onAddAgent(value);
                    setAddedCount(count => count + 1);
                  }}
                />
              )}
            </ul>
          )}
          {visibleAgents.length === 0 && editing?.kind !== 'add' && (
            <p className="team-account-agents-empty">
              {counts.agents > 0
                ? t('teamAccountAgentsAllHidden')
                : canEdit
                  ? t('teamAccountAgentsEmptyHint')
                  : t('teamAccountAgentsNone')}
            </p>
          )}
        </>
      )}

      {confirming && (
        <Modal
          labelledBy={titleId}
          onClose={() => setConfirming(false)}
          size="sm"
          initialFocus="[data-cancel]"
        >
          <h3 id={titleId}>{t('teamAccountDeleteTitle', { name: account.name })}</h3>
          <p>
            {counts.agents === 0
              ? t('teamAccountDeleteBodyEmpty')
              : t('teamAccountDeleteBody', { agents: agentsLabel(counts.agents) })}
          </p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              loading={deleting}
              onClick={() => void confirmDelete()}
            >
              {t('teamAccountDeleteConfirm')}
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
    </section>
  );
}

/** The head row as an editor: naming a new account, or renaming one. */
export function AccountNameRow({
  initialName = '',
  hold = false,
  onDirtyChange,
  onSave,
  onCancel
}: {
  initialName?: string;
  hold?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
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

  const dirty = name !== initialName;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const submit = async () => {
    const clean = normalizeTeamAccountName(name);
    if (!clean) {
      setError('teamAccountNameInvalid');
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
    } catch (cause) {
      setError(nameErrorKey(cause));
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
    <div className="team-account-head is-editing">
      <div className="team-account-edit-fields">
        <EditField
          inputRef={field}
          className="team-account-edit-name"
          value={name}
          label={t('teamAccountNamePlaceholder')}
          onChange={value => {
            setName(value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
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
      <div className="team-account-actions">
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
    </div>
  );
}
