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

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import { ChevronDown, Paperclip, UserRound } from 'lucide-react';
import type { TeamTaskPatch, TeamTaskStatus, TeamTaskSummary } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskProgressScale } from './TaskProgressScale';
import { TaskStatusControl } from './TaskStatusControl';
import { TaskAgentTagList } from './TaskAgentTags';

/** "5 Sep" on the card; the full date and time in its tooltip. */
function formatCreated(language: 'en' | 'uk', iso: string, full = false): string {
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  const date = new Date(iso);
  if (full) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(date);
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, [role="slider"]'));
}

export function TaskCard({
  task,
  canEdit,
  onOpen,
  onUpdate
}: {
  task: TeamTaskSummary;
  canEdit: boolean;
  onOpen: () => void;
  onUpdate: (patch: TeamTaskPatch) => Promise<TeamTaskSummary>;
}) {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<TeamTaskStatus>(task.status);
  const [progressValue, setProgressValue] = useState(task.progressValue);
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * The description is clamped to what fits a card; when there is more, a
   * "more" unfolds it in place — reading the whole brief must not cost
   * opening the editor. Whether there *is* more is measured, not guessed.
   */
  const [expanded, setExpanded] = useState(false);
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
    setProgressValue(task.progressValue);
  }, [task.id, task.progressValue]);

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

  const update = async (patch: TeamTaskPatch, reset: () => void) => {
    if (!canEdit || updating) return;
    setUpdating(true);
    setFailed(false);
    try {
      await onUpdate(patch);
    } catch {
      reset();
      setFailed(true);
    } finally {
      setUpdating(false);
    }
  };

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
    <article
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
        <TaskStatusControl
          compact
          value={status}
          disabled={!canEdit || updating}
          onChange={next => {
            if (next === status) return;
            const previous = status;
            setStatus(next);
            void update({ status: next }, () => setStatus(previous));
          }}
        />
        <TaskAgentTagList tags={task.agents} limit={2} />
        <time
          className="team-task-card-date"
          dateTime={task.createdAt}
          title={t('teamTaskCreatedAt', { date: formatCreated(language, task.createdAt, true) })}
        >
          {formatCreated(language, task.createdAt)}
        </time>
      </div>

      <TaskProgressScale
        value={progressValue}
        max={task.progressMax}
        label={t('teamTaskProgressScale')}
        disabled={!canEdit || updating}
        onChange={setProgressValue}
        onCommit={next => {
          const previous = task.progressValue;
          void update({ progressValue: next }, () => setProgressValue(previous));
        }}
      />

      {/* The task itself: the title, and the brief in full colour. The title's
          tooltip appears only when the title is cut — a hint that repeats
          what is already legible only covers the brief under it. */}
      <h3 ref={titleRef} title={titleClamped ? task.title : undefined}>
        {task.title}
      </h3>
      <div className="team-task-card-description">
        {task.note ? (
          <p ref={noteRef}>{task.note}</p>
        ) : (
          <span>{t('teamTaskDescriptionEmpty')}</span>
        )}
        {(clamped || expanded) && (
          <button
            type="button"
            className="team-task-card-more"
            aria-expanded={expanded}
            onClick={() => setExpanded(current => !current)}
          >
            <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(expanded ? 'teamTaskCardLess' : 'teamTaskCardMore')}
          </button>
        )}
      </div>

      <div className="team-task-card-footer">
        {/* A zero is not information here: the footer says what the task has. */}
        {task.attachmentCount > 0 && (
          <span
            className="team-task-card-attachments"
            title={t('teamTaskAttachmentsCount', { count: task.attachmentCount })}
          >
            <Paperclip size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {task.attachmentCount}
          </span>
        )}
        {task.assigneeLabelSnapshot && (
          <span className="team-task-assignee" title={t('teamTaskAssignee')}>
            <UserRound size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {task.assigneeLabelSnapshot}
          </span>
        )}
        {failed && <span className="team-task-card-error">{t('teamTaskSaveFailed')}</span>}
      </div>
    </article>
  );
}
