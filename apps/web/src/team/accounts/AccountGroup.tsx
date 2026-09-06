/**
 * One account and the agents inside it.
 *
 * The head row is the account: its name, and the same summary every time —
 * how many agents it holds, how many of those are free and how many are
 * running — followed by the three things you do to an account: put an agent in
 * it, rename it, delete it. The summary is the reason the head is worth its
 * height: folded, it is the only thing left, and "2 agents" alone never said
 * whether there was anywhere to start.
 *
 * The column captions are not here. They belong to the list, which prints them
 * once above every account rather than four times down the page.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2, UserRound, X } from 'lucide-react';
import {
  countTeamAccounts,
  normalizeTeamAccountName,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamAgentRun,
  type TeamAgentRunMarker,
  type TeamTaskLabel,
  type TeamTaskLabelRef
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute } from '../routes';
import { AgentEditRow, AgentRow, EditField } from './AgentRow';
import { Marked } from './Marked';
import { agentCountKey, busyCountKey, freeCountKey, taskCountKey } from './plural';

const ICON = 18;

/**
 * The hues an account can be known by.
 *
 * Eight of them, far enough apart to tell two accounts apart at a glance, and
 * all kept out of the three bands this screen already spends on meaning: green
 * is a free agent, amber is a running one, red is a deletion. An account
 * painted amber would have been saying "running" down its whole column.
 */
const ACCOUNT_HUES = [265, 300, 210, 330, 190, 245, 285, 225] as const;

/**
 * The colour an account is known by, down its own rows.
 *
 * Chosen by the account's id, so it is the same on every screen and every
 * member's machine without a column to store it, and unchanged when the
 * account is renamed. FNV-1a, so two ids that differ in one character do not
 * land on the same hue; saturation and lightness are the theme's job.
 */
/** The agent tags on an account's agents, each with how many carry it. */
function countAgentsByLabel(
  agents: readonly TeamAccountAgentSummary[]
): { label: TeamTaskLabelRef; count: number }[] {
  const byId = new Map<string, { label: TeamTaskLabelRef; count: number }>();
  for (const agent of agents) {
    for (const label of agent.labels) {
      const entry = byId.get(label.id) ?? { label, count: 0 };
      entry.count += 1;
      byId.set(label.id, entry);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.label.name.localeCompare(right.label.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

export function teamAccountHue(accountId: string): number {
  let hash = 0x811c9dc5;
  for (const character of accountId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ACCOUNT_HUES[hash % ACCOUNT_HUES.length];
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
  search = '',
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
  onSetRunMarker,
  onSetMoney,
  onToggleLabel,
  agentLabels = [],
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
  /** What is typed in the search, so the rows can mark what answered it. */
  search?: string;
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
  /** The agent half of the space's tag dictionary (019). */
  agentLabels?: readonly TeamTaskLabel[];
  onSetMoney: (
    agent: TeamAccountAgentSummary,
    balance: number | null,
    topup: number | null
  ) => Promise<void>;
  onToggleLabel: (agent: TeamAccountAgentSummary, labelId: string, next: boolean) => Promise<void>;
  onSetRunMarker: (
    agent: TeamAccountAgentSummary,
    run: TeamAgentRun,
    marker: TeamAgentRunMarker | null
  ) => Promise<void>;
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
  /**
   * How many of the account's agents carry each agent tag (019), in the order
   * the tags read. Counted over every agent of the account, like free and
   * busy beside it — the head describes the account, not what a filter has
   * left on screen.
   */
  const labelCounts = countAgentsByLabel(account.agents);
  const filteredOut = visibleAgents.length < counts.agents;
  /*
   * Counted over what is on screen, not over what the account owns: under a
   * search that left one agent of three, the head used to offer a link to
   * three accounts' worth of tasks — tasks of agents the filter had removed.
   */
  const taskCount = visibleAgents.reduce((total, agent) => total + agent.taskCount, 0);
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
  /*
   * The head says how the account stands, folded or open: how many agents, how
   * many free, how many running. A zero is left out rather than printed — "2
   * agents · 2 running" already says none are free — but with any agent at all
   * one of the two is always there, so a folded account never keeps its state
   * to itself the way "2 agents" alone used to.
   */

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
        /*
         * Only if the focus was actually dropped. The frame this waits for is
         * long enough to press something else in — a row's "…", say — and
         * putting the focus "back" then took it off the menu that had just
         * opened and closed it in the same breath.
         */
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
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
    // The tag is text now, so the copy beside it is the row's first focusable.
    `[data-agent-row-id="${agentRowId}"] .team-agent-copy`
  ];
  /** Back to the pencil that opened the rename, or the fold toggle for a viewer. */
  const HEAD_FOCUS = ['.team-account-actions .team-agent-action', '.team-account-toggle'];

  /**
   * The whole strip folds the account — except when the press was the end of a
   * drag over the name. Selecting "v31" to paste it somewhere is a thing
   * people do to a heading, and it should not cost them the account's rows.
   */
  const foldFromHead = () => {
    if (window.getSelection()?.isCollapsed === false) return;
    onCollapsedChange(open);
  };

  return (
    <section
      ref={root}
      className={`team-account${open ? '' : ' is-collapsed'}`}
      aria-labelledby={nameId}
      data-account-id={account.id}
      style={{ '--team-account-hue': teamAccountHue(account.id) } as CSSProperties}
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
        /* The whole strip folds the account, not just the chevron: pressing
           the name is what a hand does, and a 32px triangle was the only
           thing that answered. The buttons on the right stop the press from
           reaching it. */
        /* No role and no key handler on purpose: the chevron beside it is a
           real button carrying the same action and `aria-expanded`, so this
           only widens the target for a pointer. `role="presentation"` was
           worse than nothing here — it claims there is no semantics to
           remove, which is neither true nor the point. */
        <div className="team-account-head" onClick={foldFromHead}>
          <div className="team-account-title">
            <button
              type="button"
              className="team-account-toggle"
              aria-expanded={open}
              aria-label={t(open ? 'teamAccountCollapse' : 'teamAccountExpand', {
                name: account.name
              })}
              onClick={event => {
                event.stopPropagation();
                onCollapsedChange(open);
              }}
            >
              <ChevronDown size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            {/* The social account: an icon and the name. The icon is what
                tells it apart from the ad accounts listed under it. */}
            <span className="team-account-mark" aria-hidden="true">
              <UserRound size={ICON} strokeWidth={ICON_STROKE} />
            </span>
            <h3 className="team-account-name" id={nameId} title={account.name}>
              <Marked text={account.name} term={search} />
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
                  {counts.free > 0 && (
                    <span className="team-account-meta-free">
                      {t(freeCountKey(language, counts.free), { count: counts.free })}
                    </span>
                  )}
                  {counts.busy > 0 && (
                    <span className="team-account-meta-busy">
                      {t(busyCountKey(language, counts.busy), { count: counts.busy })}
                    </span>
                  )}
                  {/* How the account's agents are split between the tags on
                      them (019): the same chips the rows carry, each with the
                      number of agents under it, so a batch can be counted
                      without opening the account. */}
                  {labelCounts.map(({ label, count }) => (
                    <span
                      key={label.id}
                      className="team-task-label-chip is-count"
                      data-color={label.color}
                      title={t('teamAccountAgentsByTag', { tag: label.name, count })}
                    >
                      <span className="team-task-label-chip-dot" aria-hidden="true" />
                      <span className="team-task-label-chip-name">{label.name}</span>
                      <b>{count}</b>
                    </span>
                  ))}
                </>
              )}
              {taskCount > 0 && (
                <a
                  className="team-account-tasks-link"
                  href={accountTasksHref}
                  title={t('teamAccountTasksLinkTitle')}
                  onClick={event => {
                    event.stopPropagation();
                    internalLink(event, accountTasksHref);
                  }}
                >
                  {t(taskCountKey(language, taskCount), { count: taskCount })}
                </a>
              )}
            </span>
          </div>
          {/* Nothing here folds the account: each of these is its own action,
              and the press stops before it reaches the strip. */}
          <div className="team-account-actions" onClick={event => event.stopPropagation()}>
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
                    search={search}
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
                    onSetRunMarker={(run, marker) => onSetRunMarker(agent, run, marker)}
                    agentLabels={agentLabels}
                    onSetMoney={(balance, topup) => onSetMoney(agent, balance, topup)}
                    onToggleLabel={(labelId, next) => onToggleLabel(agent, labelId, next)}
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
