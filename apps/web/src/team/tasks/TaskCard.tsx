/**
 * A task on the board.
 *
 * Built for the three things a board is looked at for: to see at a glance
 * what is running where and how far (the top strip: status, account, date,
 * then the scale), to read the brief without opening anything (the title and
 * the description are the body of the card, in full colour, with a "more"
 * that unfolds the rest in place), and to nudge a task along with one press
 * (status and scale write at once). The chrome is one row; the task is the
 * rest.
 */

import { TaskAttachmentsPeek } from './TaskAttachmentsPeek';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import { ChevronDown, MoreHorizontal, Paperclip, UserRound } from 'lucide-react';
import { teamTaskDate } from '@video-compressor/shared';
import type { TeamTaskPatch, TeamTaskStatus, TeamTaskSummary } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskProgressScale } from './TaskProgressScale';
import { useCoalescedWrite } from './useCoalescedWrite';
import { TaskStatusControl } from './TaskStatusControl';
import { TaskAgentTagList } from './TaskAgentTags';
import { TaskLabelChips } from '../labels/TaskLabelChip';
import { formatTaskDate } from './TaskDateField';
import { Card, Checkbox, DropdownMenu, IconButton } from '../../components/ui/index';
import { useTaskActions, type TaskActionHandlers } from './useTaskActions';
import type { TeamMemberSummary } from '../../api/team';
import type { TeamTaskLabel } from '@video-compressor/shared';

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('button, a, label, input, [role="slider"], [role="checkbox"]'))
  );
}

export function TaskCard({
  task,
  canEdit,
  showProgress = true,
  expanded: expandedProp,
  onExpandedChange,
  onOpen,
  onUpdate,
  members = [],
  labels = [],
  actions,
  selected,
  onSelectedChange
}: {
  task: TeamTaskSummary;
  canEdit: boolean;
  /**
   * Whether the card draws its progress scale. The board's own choice — some
   * teams run on the scale, some never touch it — kept out of the card so one
   * press can put it away everywhere.
   */
  showProgress?: boolean;
  /**
   * Whether the brief is unfolded. Controlled by the board when it supplies
   * `onExpandedChange` — that is what lets "Unfold all" reach every card —
   * and local otherwise, so a card mounted on its own still folds.
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onOpen: () => void;
  onUpdate: (patch: TeamTaskPatch) => Promise<TeamTaskSummary>;
  /**
   * What the card can do without opening the task (024, FR-076).
   *
   * Behind one overflow, and only that one: the whole card stays the way in,
   * which is what a board is for. Absent where the board has not wired it, so
   * a card mounted on its own is still just a card.
   */
  members?: readonly TeamMemberSummary[];
  labels?: readonly TeamTaskLabel[];
  actions?: TaskActionHandlers;
  /**
   * Whether this card is in the set a bulk action applies to.
   *
   * Absent means the board is not offering selection at all, and the card
   * draws no tick box — which is the state it should be in on a board nobody
   * is doing bulk work on.
   */
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
}) {
  const { t, language } = useI18n();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<TeamTaskStatus>(task.status);
  const [progressValue, setProgressValue] = useState(task.progressValue);
  const [failed, setFailed] = useState(false);
  const latestTask = useRef(task);
  latestTask.current = task;
  /*
   * Progress and status are written as they change, and a change made while a write is out is sent
   * right after it — never dropped. A failure shows the task as the server has it.
   */
  const writer = useCoalescedWrite<TeamTaskPatch>({
    write: async patch => {
      setFailed(false);
      await onUpdate(patch);
    },
    merge: (held, next) => ({ ...held, ...next }),
    onError: () => {
      setStatus(latestTask.current.status);
      setProgressValue(latestTask.current.progressValue);
      setFailed(true);
    }
  });
  /**
   * The description is clamped to what fits a card; when there is more, a
   * "more" unfolds it in place — reading the whole brief must not cost
   * opening the editor. Whether there *is* more is measured, not guessed.
   */
  const menuItems = useTaskActions({
    tasks: [task],
    canEdit,
    members,
    labels,
    handlers: actions ?? { patch: () => undefined }
  });
  const dateValue = teamTaskDate(task);
  const createdOn = teamTaskDate({ dateOn: null, createdAt: task.createdAt });
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = onExpandedChange ? (expandedProp ?? false) : localExpanded;
  const setExpanded = (next: boolean) =>
    onExpandedChange ? onExpandedChange(next) : setLocalExpanded(next);
  const [clamped, setClamped] = useState(false);
  const [titleClamped, setTitleClamped] = useState(false);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setStatus(task.status);
  }, [task.status]);
  // The progress marker is manual: it follows a genuine change to its own value
  // (or a different task), never a status flip or any other edit. Re-syncing on
  // every updatedAt let a status change snap the marker back to the stored value.
  useEffect(() => {
    // While a write is out the knob shows what was chosen, not the reply to an earlier one.
    if (!writer.savingRef.current) setProgressValue(task.progressValue);
    // The reply to the last write arrives as a new progressValue and syncs then.
  }, [task.id, task.progressValue, writer.savingRef]);

  useLayoutEffect(() => {
    const node = noteRef.current;
    const title = titleRef.current;
    const measure = () => {
      setClamped(node ? node.scrollHeight > node.clientHeight + 1 : false);
      setTitleClamped(title ? title.scrollHeight > title.clientHeight + 1 : false);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (node) observer?.observe(node);
    if (title) observer?.observe(title);
    return () => observer?.disconnect();
  }, [task.note, task.title, expanded]);

  const openFromClick = (event: MouseEvent<HTMLElement>) => {
    if (!isInteractiveTarget(event.target)) onOpen();
  };
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    /* The inventory's surface (021, T104). The whole card is the target, which
       is what `interactive` says; the board's own class keeps its layout. */
    <Card
      as="article"
      interactive
      className={`team-task-card${expanded ? ' is-expanded' : ''}`}
      data-status={status}
      tabIndex={0}
      aria-label={t('teamTaskOpenCard', { name: task.title })}
      onClick={openFromClick}
      onKeyDown={openFromKeyboard}
    >
      {/* One strip of chrome: the status, the accounts it is on (017) in the
          same outline, and the date it was made in the corner. */}
      <div className="team-task-card-strip">
        {onSelectedChange && (
          <Checkbox
            className="team-task-card-select"
            checked={selected === true}
            aria-label={t('teamTaskSelectCard', { name: task.title })}
            onChange={next => onSelectedChange(next)}
          />
        )}
        <TaskStatusControl
          compact
          value={status}
          disabled={!canEdit}
          onChange={next => {
            if (next === status || !canEdit) return;
            setStatus(next);
            writer.send({ status: next });
          }}
        />
        <TaskAgentTagList tags={task.agents} limit={2} />
        {/* The team's own tags (018), in the same strip and the same shape as
            the agent tags — their colour is what tells the two apart. */}
        <TaskLabelChips labels={task.labels} limit={3} />
        {/* The day the task is for — its own date once someone sets one, the
            day it was made until then. */}
        <time
          className="team-task-card-date"
          dateTime={dateValue}
          title={
            task.dateOn
              ? `${t('teamTaskDateOn', { date: formatTaskDate(language, dateValue, true) })}\n${t('teamTaskCreatedAt', { date: formatTaskDate(language, createdOn, true) })}`
              : t('teamTaskCreatedAt', { date: formatTaskDate(language, createdOn, true) })
          }
        >
          {formatTaskDate(language, dateValue)}
        </time>
        {/* One door to everything else the card can do. Not a row of icons:
            past the status control, nothing here is used often enough to earn
            a permanent place on fifty cards at once (024, FR-076). */}
        {actions && menuItems.length > 0 && (
          <>
            <IconButton
              ref={menuAnchor}
              size="xs"
              variant="ghost"
              color="neutral"
              className="team-task-card-menu"
              label={t('teamTaskCardActions', { name: task.title })}
              onClick={() => setMenuOpen(current => !current)}
            >
              <MoreHorizontal size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            <DropdownMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchor={menuAnchor}
              placement="bottom-end"
              selection="single"
              items={menuItems}
              label={t('teamTaskCardActions', { name: task.title })}
            />
          </>
        )}
      </div>

      {/* The task itself: the title, and the brief in full colour. The title's
          tooltip appears only when the title is cut — a hint that repeats
          what is already legible only covers the brief under it. */}
      <h3 ref={titleRef} title={titleClamped ? task.title : undefined}>
        {task.title}
      </h3>
      {/* No brief, no line: "Add a description" on every card of a board read as a to-do list
          of its own, the same grey words repeated down the page (024; Linear shows nothing). */}
      <div className="team-task-card-description">
        {task.note && <p ref={noteRef}>{task.note}</p>}
        {(clamped || expanded) && (
          <button
            type="button"
            className="team-task-card-more"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(expanded ? 'teamTaskCardLess' : 'teamTaskCardMore')}
          </button>
        )}
      </div>

      {/* How far along, under what the task is (024, benchmarked on Linear's
          board, where the title is what a card is read by). */}
      {showProgress && (
        <TaskProgressScale
          value={progressValue}
          max={task.progressMax}
          label={t('teamTaskProgressScale')}
          disabled={!canEdit}
          onChange={setProgressValue}
          onCommit={next => {
            if (canEdit) writer.send({ progressValue: next });
          }}
        />
      )}

      <div className="team-task-card-footer">
        {/* A zero is not information here: the footer says what the task has. */}
        {task.attachmentCount > 0 && (
          <TaskAttachmentsPeek
            teamId={task.teamId}
            taskId={task.id}
            count={task.attachmentCount}
            trigger={
              <span
                className="team-task-card-attachments"
                tabIndex={0}
                aria-label={t('teamTaskAttachmentsCount', { count: task.attachmentCount })}
              >
                <Paperclip size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {task.attachmentCount}
              </span>
            }
          />
        )}
        {task.assigneeLabelSnapshot && (
          <span className="team-task-assignee" title={t('teamTaskAssignee')}>
            <UserRound size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {task.assigneeLabelSnapshot}
          </span>
        )}
        {failed && (
          <span className="team-task-card-error ui-color-error" role="alert">
            {t('teamTaskSaveFailed')}
          </span>
        )}
      </div>
    </Card>
  );
}
