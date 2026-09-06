/**
 * One agent under an account, in whichever of its states it is in.
 *
 * Reading it, left to right: the agent as `v31-434` with a copy beside it, the
 * one word that says whether it is free or running, the runs written on it —
 * one line each, dated — how many tasks name it, and the two things you do to
 * the agent itself.
 *
 * The two levels are kept apart on purpose. A run's pencil and bin sit on the
 * run's own line and are small; the agent's own edit and delete live behind
 * the row's "…", so a press meant for a run can never be a deleted agent. The
 * one action promoted out of the menu is freeing a busy agent, because that is
 * the thing this list is opened to do.
 *
 * Being corrected: the same row. The id is edited as a field in place of the
 * chip; a run is edited as a field in place of its line; a new run is a field
 * under the last line. Enter saves, Escape lets go.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { Check, CircleCheck, Copy, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  nextTeamAgentRunMarker,
  normalizeTeamAgentId,
  normalizeTeamAgentNote,
  teamAgentLabel,
  type TeamAccountAgentSummary,
  type TeamAgentRun,
  type TeamAgentRunMarker,
  type TeamTaskLabel
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button, IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type Language, type TranslationKey } from '../../i18n';
import { copyText } from '../../two-factor/clipboard';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { Marked } from './Marked';
import { AgentLabels } from './AgentLabels';
import { AgentMoney } from './AgentMoney';
import { runCountKey, taskCountKey } from './plural';

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
  // A stamp from the future says nothing a person can use, and today is what
  // almost every line would say. Both leave the line bare.
  if (days >= 0) return null;
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

/**
 * At most one row menu is open in the list at a time. A `pointerdown` outside
 * closes the one that is open, but a keyboard never issues one — Enter on a
 * second row's "…" left two menus open, both claiming `aria-expanded`, and
 * Escape then ran in both and threw the focus at whichever trigger answered
 * last. So opening registers here, and registering closes whoever held it.
 */
let closeOpenAgentMenu: (() => void) | null = null;

/**
 * The row's own actions, behind a "…": correcting the id and deleting the
 * agent. Both are rare and both are destructive of something typed, which is
 * exactly why they do not sit beside a run's pencil and bin.
 *
 * It is a real menu, so it takes the keys a menu takes: it opens onto its
 * first item, the arrows and Home/End walk it, Escape and Tab close it, and
 * the focus goes back to the "…" that opened it — including after the delete
 * dialog, which is why the trigger's ref belongs to the row above.
 */
function AgentMenu({
  label,
  editLabel,
  deleteLabel,
  triggerRef,
  onEdit,
  onDelete
}: {
  label: string;
  editLabel: string;
  deleteLabel: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /** Which item the roving focus is on; only that one is tabbable. */
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [triggerRef]
  );

  useEffect(() => {
    if (!open) return;
    closeOpenAgentMenu?.();
    const forget = () => setOpen(false);
    closeOpenAgentMenu = forget;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      if (closeOpenAgentMenu === forget) closeOpenAgentMenu = null;
    };
  }, [open]);

  // Opening lands on the first item, as a menu does.
  useEffect(() => {
    if (open) items.current[active]?.focus();
  }, [open, active]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = items.current.length - 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    // Tab leaves the menu rather than walking into the row behind it.
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(index => (index >= last ? 0 : index + 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => (index <= 0 ? last : index - 1));
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(last);
    }
  };

  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };

  const item = (
    index: number,
    className: string,
    ariaLabel: string,
    icon: ReactNode,
    text: string,
    onClick: () => void
  ) => (
    <button
      ref={element => {
        items.current[index] = element;
      }}
      type="button"
      role="menuitem"
      tabIndex={active === index ? 0 : -1}
      className={className}
      aria-label={ariaLabel}
      onFocus={() => setActive(index)}
      onClick={onClick}
    >
      {icon}
      {text}
    </button>
  );

  return (
    <div className="team-agent-menu" ref={box}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button team-agent-action team-agent-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setActive(0);
          setOpen(value => !value);
        }}
      >
        <MoreHorizontal size={ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="team-agent-menu-list"
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          // The pointer can leave a menu without a click — into another row's
          // trigger, or out of the window. Losing the focus closes it too.
          onBlur={event => {
            if (event.relatedTarget instanceof Node && box.current?.contains(event.relatedTarget)) {
              return;
            }
            setOpen(false);
          }}
        >
          {item(
            0,
            'team-agent-menu-item',
            editLabel,
            <Pencil size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            t('teamAgentEdit'),
            () => choose(onEdit)
          )}
          {/* Last, and alone in its danger colour: the one press in this menu
              that cannot be taken back by typing again. */}
          {item(
            1,
            'team-agent-menu-item is-danger',
            deleteLabel,
            <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            t('teamAgentDelete'),
            () => choose(onDelete)
          )}
        </div>
      )}
    </div>
  );
}

export function AgentRow({
  agent,
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
  onSetMoney,
  onToggleLabel,
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
  /** The two figures on the agent (019), written together. */
  onSetMoney: (balance: number | null, topup: number | null) => Promise<void>;
  onToggleLabel: (labelId: string, next: boolean) => Promise<void>;
  onRelease: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  /**
   * The "…" the menu hangs from. The delete dialog returns focus here by hand:
   * the menu item that opened it is gone by the time the dialog reads
   * `document.activeElement`, so what it would remember is `<body>`.
   */
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = agent.runs.length === 0;
  const tag = teamAgentLabel(accountName, agent.agentId);
  const waiting = busy || pending;
  /** Every row's buttons say which agent they act on, not just what they do. */
  const named = (key: TranslationKey) => `${t(key)} ${tag}`;
  const tooltip = agentTooltip(accountName, agent, t);

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
  const releaseLabel = `${named('teamAgentRelease')} · ${t('teamAgentReleaseCount', {
    runs: t(runCountKey(language, agent.runs.length), { count: agent.runs.length })
  })}`;
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
   * How many tasks name this agent, and the way to them — on the run's own
   * line, where it is read with the run. It had a column of its own, and that
   * column was a hundred pixels of em dashes: the owner read those dashes as a
   * delete mark and pressed them.
   */
  const tasksLink =
    agent.taskCount > 0 ? (
      <a
        className="team-agent-tasks-link"
        href={tasksHref}
        title={t('teamAgentTasksLinkTitle')}
        onClick={event => internalLink(event, tasksHref)}
      >
        {t(taskCountKey(language, agent.taskCount), { count: agent.taskCount })}
      </a>
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
    <li
      className={`team-agent-row${free ? ' is-free' : ''}${pending ? ' is-pending' : ''}`}
      data-agent-row-id={agent.id}
      data-free={free ? 'true' : 'false'}
      aria-busy={pending || undefined}
    >
      <span className="team-agent-rail" aria-hidden="true" />
      {/* The agent's identity is `v31-434` — the account and the tail of the
          id, the same chip a task shows — so an ad account never reads like a
          second social account, however its id happens to end. It is text, not
          a button: the copy is the small mark beside it, which is the rare
          thing, and the identity itself no longer spends the row's largest
          target on it. */}
      <div className="team-agent-id">
        <span
          className={`team-agent-tag${free ? ' is-free' : ''}${revealed ? ' is-revealed' : ''}`}
          title={tooltip}
        >
          <span className="team-task-agent-chip-dot" aria-hidden="true" />
          <span className="team-agent-tag-text">
            <Marked text={revealed ? agent.agentId : tag} term={search} />
          </span>
        </span>
        <IconButton
          label={`${named('teamAgentCopyId')}: ${agent.agentId}`}
          title={tooltip}
          className={`team-agent-action is-small team-agent-copy${copied ? ' is-copied' : ''}`}
          onClick={copyId}
        >
          {copied ? (
            <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <Copy size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
        </IconButton>
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
      </div>

      {/* The state in one word, in its own column, so a folded eye can run
          down it. A dot and the word, not a pill: a row already carries two
          real buttons, and a third thing shaped like one is a press wasted. */}
      <div className="team-agent-status">
        <span className={`team-agent-state${free ? ' is-free' : ' is-busy'}`}>
          <span className="team-agent-state-dot" aria-hidden="true" />
          {t(free ? 'teamAgentFree' : 'teamAgentBusy')}
        </span>
      </div>

      {/* The runs: one line each, with the day it was written. A line being
          corrected is a field; a new run is a field under the last line. */}
      <div className="team-agent-runs">
        {agent.runs.length === 0 && !editingNew && tasksLink && (
          <div className="team-agent-run is-empty">{tasksLink}</div>
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
            <div
              key={item.id}
              className={`team-agent-run${item.marker ? ` is-marked is-${item.marker}` : ''}`}
              data-run-id={item.id}
              data-marker={item.marker ?? 'none'}
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
                  title={t('teamAgentRunMarkHint')}
                  disabled={waiting || editingRun}
                  onClick={() =>
                    void run(() => onSetRunMarker(item, nextTeamAgentRunMarker(item.marker)))
                  }
                />
              )}
              <span className="team-agent-run-text">
                <Marked text={item.note} term={search} />
              </span>
              <RunAge createdAt={item.createdAt} />
              {/* Beside the run they act on. Half a screen away, at the end
                  of a column that is mostly empty, the bin of one line sat
                  level with the text of another. */}
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
                    disabled={waiting || editingRun}
                    onClick={() => void run(() => onDeleteRun(item))}
                  >
                    <Trash2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                </span>
              )}
              {index === agent.runs.length - 1 && tasksLink}
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

      {/* What the agent has and what it is owed, between the runs it is on and
          the buttons that act on it. */}
      <AgentMoney
        agent={agent}
        label={tag}
        canEdit={canEdit}
        disabled={waiting}
        onSet={onSetMoney}
      />

      <div className="team-agent-actions">
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
              {!free && (
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
            <AgentMenu
              label={named('teamAgentMore')}
              editLabel={named('teamAgentEdit')}
              deleteLabel={named('teamAgentDelete')}
              triggerRef={menuTrigger}
              onEdit={onEdit}
              onDelete={() => setConfirming(true)}
            />
          </>
        )}
      </div>

      {/* Focus starts on Cancel: Enter on the menu item and Enter again must
          not be a deletion with no pause in between. */}
      {confirming && (
        <Modal
          labelledBy={titleId}
          onClose={() => setConfirming(false)}
          size="sm"
          initialFocus="[data-cancel]"
          returnFocus={menuTrigger.current}
        >
          <h3 id={titleId}>{t('teamAgentDeleteTitle', { tag })}</h3>
          <p>{t('teamAgentDeleteBody', { id: agent.agentId })}</p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              // `pending` too, not only this row's own write: an undo from a
              // toast is in flight on the same agent, and a delete racing it
              // ends with "Agent deleted" and the undo's error side by side.
              loading={waiting}
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
