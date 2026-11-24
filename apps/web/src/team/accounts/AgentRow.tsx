import { useAccountReorderItem } from './AccountReorderProvider';
import { TEAM_ACCOUNT_NAME_COLORS, type TeamAccountNameColor } from '@video-compressor/shared';
/**
 * One agent under an account, in whichever of its states it is in.
 *
 * Reading it, left to right: the agent as `v31-434`, the one word that says
 * whether it is free or running, the runs written on it — one line each,
 * dated — its money, and one thing to do to it: write a run, or free it.
 *
 * Everything else is behind the row's "…" (070, T041/T042; 024 US14): copying
 * the full id, the money's history, correcting or deleting a run, and the
 * agent's own edit, move, order, archive and delete. A pencil and a bin on
 * every run line and a copy button beside every id were nine small controls
 * on a row that has one job; the menu's entries come from one registry,
 * `agentActions.tsx`, so a run's delete can never sit next to the agent's.
 *
 * Being corrected: the same row. The id is edited as a field in place of the
 * chip; a run is edited as a field in place of its line; a new run is a field
 * under the last line. Enter saves, Escape lets go.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, CircleCheck, MoreHorizontal, Plus, X } from 'lucide-react';
import {
  nextTeamAgentRunMarker,
  getTeamAgentAvailability,
  normalizeTeamAgentId,
  normalizeTeamAgentNote,
  teamAgentLabel,
  type TeamAccountAgentSummary,
  type TeamAgentRun,
  type TeamAgentRunMarker,
  type TeamTaskLabel
} from '@video-compressor/shared';
import { ConfirmDialog } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type Language, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { Marked } from './Marked';
import { AgentIdentity } from './AgentIdentity';
import { AgentLabels } from './AgentLabels';
import { AgentTasksPeek } from './AgentTasksPeek';
import { useTeam } from '../TeamContext';
import { copyText } from '../../two-factor/clipboard';
import { runCountKey, taskCountKey } from './plural';
import { DropdownMenu, IconButton, TableCell, TableRow } from '../../components/ui/index';
import { agentMenuEntries } from './agentActions';
import { ArchivedAccountActions } from './AccountArchiveDrawer';

const ICON = 18;

/** The locale the counted words and the dates are written in. */
function localeOf(language: Language): string {
  return language === 'uk' ? 'uk-UA' : 'en-US';
}

/**
 * When a run was written, in a couple of characters: "today", "yesterday",
 * "3 days ago", and a bare day/month once it is older than a week.
 *
 * The dates inside a run's text are typed by hand — "Keto | PL 05/09" — so
 * this is the only stamp on the row that cannot drift from what happened.
 */
export function runAgeLabel(createdAt: string, language: Language): string | null {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(new Date())) / 86_400_000);
  // A stamp from the future says nothing a person can use.
  if (days > 0) return null;
  // Today says when (024): a launch marked a minute ago left the line bare, and "is it on yet?"
  // is the question asked of today's runs.
  if (days === 0) {
    return new Intl.DateTimeFormat(localeOf(language), {
      hour: '2-digit',
      minute: '2-digit'
    }).format(at);
  }
  if (days >= -6) {
    return new Intl.RelativeTimeFormat(localeOf(language), { numeric: 'auto' }).format(days, 'day');
  }
  return new Intl.DateTimeFormat(localeOf(language), { day: '2-digit', month: '2-digit' }).format(
    at
  );
}

/** What the run's marker is called, for the press's own label. */
function markerLabelKey(marker: TeamAgentRunMarker | null): TranslationKey {
  if (marker === 'green') return 'teamAgentRunMarkerGreen';
  if (marker === 'amber') return 'teamAgentRunMarkerAmber';
  if (marker === 'red') return 'teamAgentRunMarkerRed';
  return 'teamAgentRunMarkerNone';
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
  agent: Pick<TeamAccountAgentSummary, 'agentId' | 'runs' | 'availability'>,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string {
  const lines = [
    t('teamAgentTooltipAccount', { name: accountName }),
    t('teamAgentTooltipId', { id: agent.agentId })
  ];
  for (const run of agent.runs) lines.push(t('teamAgentTooltipRun', { note: run.note }));
  const availability = getTeamAgentAvailability(agent);
  lines.push(
    t(
      availability === 'unknown'
        ? 'teamAgentAvailabilityUnknown'
        : availability === 'free'
          ? 'teamAgentFree'
          : 'teamAgentBusy'
    )
  );
  if (agent.availability?.assignmentCount)
    lines.push(t('launchesAssignmentCount', { count: agent.availability.assignmentCount }));
  return lines.join('\n');
}

/** Which run of the row is being written, if any: a new one, or one by id. */
export type RunEditing = { runId: string | null } | null;

export function AgentRow({
  agent,
  index = 0,
  focused = false,
  finance,
  linkedLaunches,
  nameColor = 0,
  onCycleColor,
  onArchive,
  onRestore,
  canManageArchived = false,
  parentArchived = false,
  onHistory,
  reorderEnabled = false,
  accountName,
  canEdit,
  pending = false,
  tasksHref,
  search = '',
  runEditing = null,
  hold = false,
  agentLabels = [],
  onDirtyChange,
  onRunEditingChange,
  onEdit,
  onAddRun,
  onUpdateRun,
  onDeleteRun,
  onSetRunMarker,
  onToggleLabel,
  onRelease,
  onMove,
  onDelete
}: {
  agent: TeamAccountAgentSummary;
  index?: number;
  /** Where a task's chip led (070, T048): drawn as the selected row for a moment. */
  focused?: boolean;
  finance?: ReactNode;
  linkedLaunches?: ReactNode;
  nameColor?: TeamAccountNameColor;
  onCycleColor?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  canManageArchived?: boolean;
  parentArchived?: boolean;
  onHistory?: () => void;
  reorderEnabled?: boolean;
  accountName: string;
  canEdit: boolean;
  /** A write on this agent is in flight elsewhere (an undo); the row waits. */
  pending?: boolean;
  /** The task list narrowed to this agent, shown when any task carries its tag. */
  tasksHref: string;
  /** What is typed in the search, so the row can mark what answered it. */
  search?: string;
  runEditing?: RunEditing;
  hold?: boolean;
  /** The agent half of the space's tag dictionary (019). */
  agentLabels?: readonly TeamTaskLabel[];
  onDirtyChange?: (dirty: boolean) => void;
  onRunEditingChange: (editing: RunEditing) => void;
  onEdit: () => void;
  onAddRun: (note: string) => Promise<void>;
  onUpdateRun: (runId: string, note: string) => Promise<void>;
  onDeleteRun: (run: TeamAgentRun) => Promise<void>;
  onSetRunMarker: (run: TeamAgentRun, marker: TeamAgentRunMarker | null) => Promise<void>;
  onToggleLabel: (labelId: string, next: boolean) => Promise<void>;
  onRelease: () => Promise<void>;
  /** Opens the transfer to another social account; absent when there is none. */
  onMove?: () => void;
  onDelete: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const reorder = useAccountReorderItem(
    { kind: 'agent', id: agent.id, parent: agent.accountId, index, label: agent.agentId },
    !canEdit || !reorderEnabled || Boolean(agent.archivedAt)
  );
  const colorKey = [
    'accountsColorNone',
    'accountsColorGreen',
    'accountsColorYellow',
    'accountsColorRed',
    'accountsColorBlue',
    'accountsColorPurple',
    'accountsColorPink',
    'accountsColorOrange'
  ] as const;
  const { push } = useToasts();
  const { activeTeam } = useTeam();
  /**
   * The "…" the menu hangs from. The delete dialog returns focus here by hand:
   * the menu item that opened it is gone by the time the dialog reads
   * `document.activeElement`, so what it would remember is `<body>`.
   */
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canMoveUp = reorder.canMove(-1);
  const canMoveDown = reorder.canMove(1);
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const availability = getTeamAgentAvailability(agent);
  const free = availability === 'free';
  const tag = teamAgentLabel(accountName, agent.agentId);
  const waiting = busy || pending;
  /** Every row's buttons say which agent they act on, not just what they do. */
  const named = (key: TranslationKey) => `${t(key)} ${tag}`;
  const tooltip = agentTooltip(accountName, agent, t);

  /**
   * The clipboard write happens inside the click, synchronously — Safari
   * refuses one issued after an await. A failed copy never looks like a
   * success: the full id is shown instead, so it can still be selected.
   */
  const copyId = () => {
    void copyText(agent.agentId).then(ok => {
      if (ok) {
        // A copy that works undoes the reveal a refused one left behind;
        // otherwise the row wore the raw id until the page was reloaded.
        setRevealed(false);
        push({ tone: 'success', text: t('teamAgentCopied', { tag }) });
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
  /**
   * While a run of this row is being written, the buttons that would throw it
   * away wait: freeing the agent or deleting the line under the caret is never
   * what the press meant.
   */
  const editingRun = runEditing !== null;
  const releaseLabel = `${named('teamAgentRelease')} · ${agent.availability?.assignmentCount ? t('launchesAssignmentCount', { count: agent.availability.assignmentCount }) + ' · ' : ''}${t(
    'teamAgentReleaseCount',
    {
      runs: t(runCountKey(language, agent.runs.length), { count: agent.runs.length })
    }
  )}`;
  /**
   * Writing a run is the point of the row, so the control says so in words.
   * On a free agent it is the row's own call to action, in place of the runs
   * it does not have; on a busy one it is a quiet "+ Run" after the last line.
   */
  const addRunButton = (
    <button
      type="button"
      className="team-agent-run-add"
      aria-label={named('teamAgentRunAdd')}
      disabled={waiting || editingNew}
      onClick={() => onRunEditingChange({ runId: null })}
    >
      <Plus size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span>{t('teamAgentRunAddShort')}</span>
    </button>
  );
  /**
   * How many tasks name this agent, and the way to them — under its state. It had a column of
   * its own, and that column was a hundred pixels of em dashes: the owner read those dashes as a
   * delete mark and pressed them. Absent when there are none.
   */
  const tasksLink =
    agent.taskCount > 0 && activeTeam ? (
      <AgentTasksPeek
        teamId={activeTeam.id}
        agentRowId={agent.id}
        agentLabel={tag}
        canEdit={canEdit}
        trigger={
          <a
            className="team-agent-tasks-link"
            href={tasksHref}
            onClick={event => internalLink(event, tasksHref)}
          >
            {t(taskCountKey(language, agent.taskCount), { count: agent.taskCount })}
          </a>
        }
      />
    ) : null;

  /*
   * The same control on a free agent, filled rather than outlined: nothing
   * else in its row competes with it. It says the same short word as the busy
   * row's, because the two now sit in one column of buttons and a column whose
   * items are different widths reads as a mistake; which of the two it is, is
   * said by the label a screen reader hears and by the Status column beside
   * it.
   */
  const assignRunButton = (
    <button
      type="button"
      className="team-agent-run-add is-assign"
      aria-label={named('teamAgentRunAssign')}
      disabled={waiting || editingNew}
      onClick={() => onRunEditingChange({ runId: null })}
    >
      <Plus size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span>{t('teamAgentRunAddShort')}</span>
    </button>
  );

  return (
    <TableRow
      ref={reorder.ref}
      data-reorder-id={agent.id}
      data-finance-social={agent.accountId}
      data-name-color-value={TEAM_ACCOUNT_NAME_COLORS[nameColor]}
      className={`team-agent-row${free ? ' is-free' : ''}${pending ? ' is-pending' : ''}`}
      data-agent-row-id={agent.id}
      data-free={free ? 'true' : 'false'}
      busy={pending}
      selected={focused}
      onKeyDown={event => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-reorder-keyboard]') &&
          event.altKey &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        ) {
          event.preventDefault();
          reorder.move(event.key === 'ArrowUp' ? -1 : 1);
        }
      }}
    >
      <span hidden ref={reorder.handleRef} />
      <span className="team-agent-rail" aria-hidden="true" />
      {/* The agent's identity is `v31-434` — the account and the tail of the
          id, the same chip a task shows — so an ad account never reads like a
          second social account, however its id happens to end. The name cycles
          personal decoration; the separate small control copies the full ID. */}
      <TableCell className="team-agent-id" aria-colindex={1}>
        <button
          type="button"
          data-name-color="true"
          data-color={TEAM_ACCOUNT_NAME_COLORS[nameColor]}
          aria-label={t('accountsColor', { color: t(colorKey[nameColor]) })}
          onClick={event => {
            if (reorder.suppressClick()) {
              event.preventDefault();
              return;
            }
            onCycleColor?.();
          }}
          className={`team-agent-tag${free ? ' is-free' : ''}${revealed ? ' is-revealed' : ''}`}
          title={tooltip}
        >
          <span className="team-task-agent-chip-dot" aria-hidden="true" />
          <span className="team-agent-tag-text">
            <AgentIdentity accountName={accountName} agentId={agent.agentId} revealed={revealed} />
          </span>
        </button>
        {/* The agent's own tags (019), beside its name — the heading the
            copied payment list will group this row under. */}
        <AgentLabels
          labels={agent.labels}
          available={agentLabels}
          canEdit={canEdit}
          busy={waiting}
          agentLabel={tag}
          onToggle={(label, next) => void run(() => onToggleLabel(label.id, next))}
        />
      </TableCell>

      {/* The state in one word, in its own column, so a folded eye can run
          down it. A dot and the word, not a pill: a row already carries two
          real buttons, and a third thing shaped like one is a press wasted. */}
      <TableCell className="team-agent-status" aria-colindex={2}>
        <span
          className={`team-agent-state${agent.archivedAt ? ' is-archived' : free ? ' is-free' : ' is-busy'}`}
        >
          <span className="team-agent-state-dot" aria-hidden="true" />
          {agent.archivedAt
            ? t('accountsArchived')
            : t(
                availability === 'unknown'
                  ? 'teamAgentAvailabilityUnknown'
                  : free
                    ? 'teamAgentFree'
                    : 'teamAgentBusy'
              )}
        </span>
        {/* Under the state, the same place on every row (024). On the last run's line it
            pushed that run's age out of line with the others, and on a free agent it stood
            under Run. Tasks belong to the agent, not to one of its runs. */}
        {tasksLink}
      </TableCell>

      {/* The runs: one line each, with the day it was written. A line being
          corrected is a field; a new run is a field under the last line. */}
      <TableCell className="team-agent-runs" aria-colindex={3}>
        {linkedLaunches}
        {agent.runs.map(item =>
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
            <div
              key={item.id}
              className={`team-agent-run${item.marker ? ` is-marked is-${item.marker}` : ''}`}
              data-run-id={item.id}
              data-marker={item.marker ?? 'none'}
              onClick={event => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest('button, a, input, textarea, select, [role="button"]')) return;
                if (waiting || editingRun) return;
                void run(() => onSetRunMarker(item, nextTeamAgentRunMarker(item.marker)));
              }}
            >
              {/*
               * The whole run is the target, as a button laid under its own
               * text rather than around it: the pencil, the bin and the tasks
               * link inside it are buttons and links of their own, and one
               * cannot be nested in another. A press cycles the colour —
               * unmarked, green, amber, red — so marking costs no menu, and
               * four presses always put the run back where it was.
               */}
              {canEdit && (
                <button
                  type="button"
                  className="team-agent-run-mark"
                  aria-label={`${t('teamAgentRunMark')}: ${item.note} · ${t(markerLabelKey(item.marker))}`}
                  disabled={waiting || editingRun}
                  onClick={() =>
                    void run(() => onSetRunMarker(item, nextTeamAgentRunMarker(item.marker)))
                  }
                />
              )}
              <span className="team-agent-run-text" title={item.note}>
                <Marked text={item.note} term={search} />
              </span>
              <RunAge createdAt={item.createdAt} />
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
      </TableCell>

      <TableCell className="team-agent-actions" aria-colindex={4}>
        {canEdit && (
          <>
            {/*
             * The two things done to the agent itself, one above the other in
             * one column: writing a run and freeing it. "+ Run" used to sit
             * after the last run line, which put it at a different distance
             * from the right edge on every row and level with a different line
             * on every agent — a control you had to find before you could
             * press it. Here the eye runs down one column and finds both.
             */}
            <div className="team-agent-actions-stack">
              {free ? assignRunButton : addRunButton}
              {/* Freeing an agent is the one thing done to the agent itself
                  often enough to be worth a word and a place of its own. */}
              {availability === 'busy' && (
                <button
                  type="button"
                  className="team-agent-release"
                  // One press clears every run on the agent, so both the name
                  // and the tooltip say how many that is before the press
                  // rather than after it.
                  aria-label={releaseLabel}
                  title={releaseLabel}
                  disabled={waiting || editingRun}
                  onClick={() => void run(onRelease)}
                >
                  <CircleCheck size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  <span className="team-agent-release-label">{t('teamAgentRelease')}</span>
                </button>
              )}
            </div>
            {/*
             * The menu itself never waits on a write in flight: both of its
             * items only *open* something — an editor, a confirmation — and
             * neither writes. Disabling them mid-open took the focus off an
             * item and left no enabled element in the row to give it back to.
             */}
          </>
        )}
        {(agent.archivedAt || parentArchived) && canManageArchived ? (
          <ArchivedAccountActions
            row={{
              id: agent.id,
              entityKind: 'agent',
              name: tag,
              archivedAt: agent.archivedAt ?? null,
              parentArchived,
              canRestore: Boolean(onRestore) && !parentArchived
            }}
            busy={waiting}
            onRestore={() => onRestore?.()}
            onDelete={() => setConfirming(true)}
          />
        ) : (
          <div className="team-agent-menu">
            <IconButton
              ref={menuTrigger}
              label={named('teamAgentMore')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="team-agent-action team-agent-menu-trigger"
              data-reorder-keyboard={canMoveUp || canMoveDown ? 'true' : undefined}
              aria-keyshortcuts={canMoveUp || canMoveDown ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              onClick={() => setMenuOpen(value => !value)}
            >
              <MoreHorizontal size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            {/* The shared menu (024, T117), its entries from the row's registry (070, T042):
                React Aria walks it, closes it on Escape, Tab and an outside press, and one
                open menu sets the rest of the page aside, so a second cannot be open. */}
            <DropdownMenu
              open={menuOpen}
              onClose={() => {
                setMenuOpen(false);
                // After the popover has let go of the page: while it is open the
                // rest of the document is inert, and focus cannot land there.
                requestAnimationFrame(() => menuTrigger.current?.focus());
              }}
              anchor={menuTrigger}
              placement="bottom-end"
              label={named('teamAgentMore')}
              className="team-agent-menu-list"
              items={agentMenuEntries(
                {
                  tag,
                  agentId: agent.agentId,
                  runs: agent.runs,
                  waiting,
                  editingRun,
                  onCopyId: copyId,
                  onHistory,
                  historyLabel: `${t('financeHistory')} · ${accountName} · ${agent.agentId}`,
                  onEditRun: canEdit ? item => onRunEditingChange({ runId: item.id }) : undefined,
                  onDeleteRun: canEdit ? item => void run(() => onDeleteRun(item)) : undefined,
                  onEdit: canEdit ? onEdit : undefined,
                  onMove: canEdit ? onMove : undefined,
                  onOrderUp: canMoveUp ? () => reorder.move(-1) : undefined,
                  onOrderDown: canMoveDown ? () => reorder.move(1) : undefined,
                  onArchive: canEdit ? onArchive : undefined,
                  onDelete: canEdit ? () => setConfirming(true) : undefined
                },
                t
              )}
            />
          </div>
        )}
      </TableCell>
      {finance}

      {/* Focus starts on Cancel: Enter on the menu item and Enter again must
          not be a deletion with no pause in between. */}
      {confirming && (canEdit || canManageArchived) && (
        <ConfirmDialog
          title={t('teamAgentDeleteTitle', { tag })}
          body={t('accountsDeleteAgentWarning')}
          confirmLabel={t('teamAgentDelete')}
          cancelLabel={t('teamCancel')}
          holdHint={t('accountsDeleteHoldHint')}
          initialFocus="cancel"
          returnFocus={menuTrigger.current}
          busy={waiting}
          onCancel={() => setConfirming(false)}
          alternative={
            onArchive && !agent.archivedAt && !parentArchived
              ? {
                  label: t('accountsArchive'),
                  onSelect: () => {
                    setConfirming(false);
                    onArchive();
                  }
                }
              : undefined
          }
          onConfirm={() =>
            void run(async () => {
              await onDelete();
              setConfirming(false);
            })
          }
        />
      )}
    </TableRow>
  );
}

/**
 * The day a run was written, beside it — muted, absent when unreadable, and
 * absent for today. On a working day nearly every line is today's, and a
 * column of "today" is a column of noise; what is worth a word is a run still
 * standing from last week.
 */
function RunAge({ createdAt }: { createdAt: string }) {
  const { t, language } = useI18n();
  const label = runAgeLabel(createdAt, language);
  if (!label) return null;
  const at = new Date(createdAt);
  return (
    <time
      className="team-agent-run-age"
      dateTime={createdAt}
      title={t('teamAgentRunAdded', {
        when: new Intl.DateTimeFormat(localeOf(language), {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(at)
      })}
    >
      {label}
    </time>
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
          title=""
          label={t('teamAccountsSave')}
          className="team-agent-action is-small is-confirm"
          disabled={saving}
          onClick={() => void submit()}
        >
          <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton
          title=""
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
  onSave: (value: { agentId: string; note: string | null; timezone?: string }) => Promise<void>;
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
      await onSave({
        agentId: cleanId,
        note: cleanNote,
        ...(adding ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {})
      });
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
    <TableRow className="team-agent-row is-editing">
      <span className="team-agent-rail" aria-hidden="true" />
      <div className="team-agent-edit-fields" role="cell" aria-colspan={3}>
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
      <div className="team-agent-actions" role="cell" aria-colindex={4}>
        <IconButton
          title=""
          label={t('teamAccountsSave')}
          className="team-agent-action is-confirm"
          disabled={saving}
          onClick={() => void submit()}
        >
          <Check size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton
          title=""
          label={t('teamCancel')}
          className="team-agent-action is-reject"
          onClick={onCancel}
        >
          <X size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </div>
    </TableRow>
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
  const ownInput = useRef<HTMLInputElement>(null);
  const fieldInput = inputRef ?? ownInput;
  return (
    <div className={`team-accounts-field ${className}`.trim()}>
      <input
        ref={fieldInput}
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
        <IconButton
          title=""
          label={t('teamAccountsClearField')}
          tabIndex={-1}
          onClick={() => {
            onChange('');
            fieldInput.current?.focus({ preventScroll: true });
          }}
        >
          <X size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
