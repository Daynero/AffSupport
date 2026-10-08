import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Progress, Tooltip } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import {
  summarize,
  TERMINAL_SYNC_STATES,
  type FolderSyncBlockedReason,
  type FolderSyncState,
  type FolderSyncStatus
} from '../syncStatus';

/**
 * What one manual sync is doing, said plainly (028, release B).
 *
 * Eight states, one chip; the counters that only grow; a reason and an action
 * when the job cannot go on; a result in numbers when it is over; and "Stop",
 * which acts on this person's request. A screen reader hears the state
 * change, not every file.
 */

const STATE_COPY: Record<FolderSyncState, TranslationKey> = {
  queued: 'teamSyncStateQueued',
  running: 'teamSyncStateRunning',
  retry_wait: 'teamSyncStateRetryWait',
  blocked: 'teamSyncStateBlocked',
  canceling: 'teamSyncStateCanceling',
  canceled: 'teamSyncStateCanceled',
  succeeded: 'teamSyncStateSucceeded',
  failed: 'teamSyncStateFailed'
};

const PHASE_COPY: Record<FolderSyncStatus['phase'], TranslationKey> = {
  listing: 'teamSyncPhaseListing',
  reconciling: 'teamSyncPhaseReconciling',
  replaying_changes: 'teamSyncPhaseReplaying',
  done: 'teamSyncPhaseDone'
};

const BLOCKED_COPY: Record<
  FolderSyncBlockedReason,
  { body: TranslationKey; action: TranslationKey }
> = {
  canonical_failed: { body: 'teamSyncBlockedCanonicalFailed', action: 'teamSyncActionRetry' },
  canonical_retrying: { body: 'teamSyncBlockedCanonicalRetrying', action: 'teamSyncActionWait' },
  needs_reauth: { body: 'teamSyncBlockedNeedsReauth', action: 'teamSyncActionReconnect' }
};

/** A stable code becomes one sentence and one thing to do. */
const ERROR_COPY: Record<string, { body: TranslationKey; action: TranslationKey }> = {
  CANONICAL_FAILED: { body: 'teamSyncErrorCanonicalFailed', action: 'teamSyncActionRetry' },
  REPLAY_TIMEOUT: { body: 'teamSyncErrorReplayTimeout', action: 'teamSyncActionRetry' },
  LEASE_LOST_EXHAUSTED: { body: 'teamSyncErrorLeaseLost', action: 'teamSyncActionRetry' },
  NO_PROGRESS: { body: 'teamSyncErrorLeaseLost', action: 'teamSyncActionRetry' },
  CONNECTION_DETACHED: { body: 'teamSyncErrorDetached', action: 'teamSyncActionReconnect' },
  NEEDS_REAUTH: { body: 'teamSyncErrorNeedsReauth', action: 'teamSyncActionReconnect' },
  PERMISSION_DENIED: { body: 'teamSyncErrorPermission', action: 'teamSyncActionGrant' },
  RATE_LIMITED: { body: 'teamSyncErrorRateLimited', action: 'teamSyncActionWait' },
  DRIVE_UNAVAILABLE: { body: 'teamSyncErrorDriveUnavailable', action: 'teamSyncActionWait' },
  CANCELED_BY_USER: { body: 'teamSyncErrorCanceled', action: 'teamSyncActionRetry' }
};

function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

function chipTone(state: FolderSyncState): 'neutral' | 'success' | 'warning' | 'error' | 'info' {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'blocked':
    case 'retry_wait':
      return 'warning';
    case 'failed':
      return 'error';
    case 'canceled':
      return 'neutral';
    default:
      return 'info';
  }
}

export function SyncStatusPanel({
  status,
  scopeName,
  onCancel,
  onRetry,
  now = Date.now()
}: {
  status: FolderSyncStatus;
  /** The folder's name, or the space's. */
  scopeName: string;
  onCancel?: () => void;
  onRetry?: () => void;
  now?: number;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const announcedState = useRef<FolderSyncState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const terminal = TERMINAL_SYNC_STATES.has(status.state);

  // One announcement per state change: "syncing" once, not "17 files" forever.
  useEffect(() => {
    if (announcedState.current === status.state) return;
    announcedState.current = status.state;
    setAnnouncement(`${scopeName}: ${t(STATE_COPY[status.state])}`);
  }, [status.state, scopeName, t]);

  const started = minutesSince(status.startedAt, now);
  const progressed = minutesSince(status.lastProgressAt, now);
  const nextAttempt = status.nextAttemptAt
    ? Math.max(0, Math.round((Date.parse(status.nextAttemptAt) - now) / 60_000))
    : null;
  const blocked = status.blockedReason ? BLOCKED_COPY[status.blockedReason] : null;
  const failure =
    status.state === 'failed' || status.state === 'canceled'
      ? (ERROR_COPY[status.errorDetail ?? ''] ??
        ERROR_COPY[status.errorCode ?? ''] ?? {
          body: 'teamSyncErrorUnknown' as TranslationKey,
          action: 'teamSyncActionRetry' as TranslationKey
        })
      : null;
  const summary = status.state === 'succeeded' ? summarize(status) : null;
  const total = status.pendingFolders === null ? null : status.foldersDone + status.pendingFolders;
  const percent = total && total > 0 ? Math.round((status.foldersDone / total) * 100) : undefined;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(
        `job ${status.jobId}${status.requestId ? ` request ${status.requestId}` : ''}`
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // The id is still on screen for a manual copy.
    }
  };

  return (
    <section className="team-sync-panel" aria-label={t('teamSyncPanelLabel', { scope: scopeName })}>
      <div className="team-sync-panel-head">
        <Chip color={chipTone(status.state)} variant="soft" size="sm">
          {t(STATE_COPY[status.state])}
        </Chip>
        <span className="team-sync-panel-scope">{scopeName}</span>
        {!terminal && <span className="team-sync-panel-phase">{t(PHASE_COPY[status.phase])}</span>}
        {status.sharedWith > 0 && (
          <Tooltip label={t('teamSyncSharedTooltip', { count: status.sharedWith })}>
            <Chip color="neutral" variant="outline" size="xs">
              {t('teamSyncShared', { count: status.sharedWith })}
            </Chip>
          </Tooltip>
        )}
        <span className="team-sync-panel-actions">
          {status.cancelable && onCancel && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCancel}
              disabled={status.state === 'canceling'}
            >
              {status.state === 'canceling' ? t('teamSyncStopping') : t('teamSyncStop')}
            </Button>
          )}
          {(status.state === 'failed' ||
            status.state === 'blocked' ||
            status.state === 'canceled') &&
            onRetry && (
              <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
                {t('teamSyncRunAgain')}
              </Button>
            )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? t('teamSyncLess') : t('teamSyncMore')}
          </Button>
        </span>
      </div>

      {!terminal && (
        <Progress
          value={percent}
          size="xs"
          label={t('teamSyncProgressLabel', { scope: scopeName })}
          valueText={
            total === null
              ? t('teamSyncProgressOpen', {
                  folders: status.foldersDone,
                  files: status.filesListed
                })
              : t('teamSyncProgressKnown', {
                  done: status.foldersDone,
                  total,
                  files: status.filesListed
                })
          }
        />
      )}

      <p className="team-sync-panel-line">
        {summary && summary.kind === 'changes' && (
          <span>
            {t('teamSyncSummaryChanges', {
              added: summary.added,
              updated: summary.updated,
              removed: summary.removed
            })}
          </span>
        )}
        {summary && summary.kind === 'none' && <span>{t('teamSyncSummaryNone')}</span>}
        {summary && summary.kind === 'partial' && (
          <span>
            {t('teamSyncSummaryPartial', {
              added: summary.added,
              updated: summary.updated,
              removed: summary.removed,
              unavailable: summary.unavailable
            })}
          </span>
        )}
        {!terminal && status.phase === 'replaying_changes' && (
          <span>{t('teamSyncReplayingLine', { files: status.filesListed })}</span>
        )}
        {!terminal && status.phase !== 'replaying_changes' && (
          <span>
            {total === null
              ? t('teamSyncProgressOpen', {
                  folders: status.foldersDone,
                  files: status.filesListed
                })
              : t('teamSyncProgressKnown', {
                  done: status.foldersDone,
                  total,
                  files: status.filesListed
                })}
            {status.itemsUnavailable > 0 && (
              <> · {t('teamSyncUnavailableCount', { count: status.itemsUnavailable })}</>
            )}
          </span>
        )}
        {status.state === 'retry_wait' && nextAttempt !== null && (
          <span>
            {' '}
            · {t('teamSyncNextAttempt', { count: nextAttempt })}
            {status.errorCode && ERROR_COPY[status.errorCode] && (
              <> · {t(ERROR_COPY[status.errorCode]!.body)}</>
            )}
          </span>
        )}
      </p>

      {blocked && (
        <p className="team-sync-panel-reason" role="status">
          {t(blocked.body)} {t(blocked.action)}
        </p>
      )}
      {failure && (
        <p className="team-sync-panel-reason" role="status">
          {t(failure.body)} {t(failure.action)}
        </p>
      )}

      {expanded && (
        <dl className="team-sync-panel-details">
          <dt>{t('teamSyncDetailStarted')}</dt>
          <dd>{started === null ? '—' : t('teamSyncMinutesAgo', { count: started })}</dd>
          <dt>{t('teamSyncDetailProgress')}</dt>
          <dd>{progressed === null ? '—' : t('teamSyncMinutesAgo', { count: progressed })}</dd>
          <dt>{t('teamSyncDetailListed')}</dt>
          <dd>{status.filesListed}</dd>
          <dt>{t('teamSyncDetailChanged')}</dt>
          <dd>
            {t('teamSyncSummaryChanges', {
              added: status.filesAdded,
              updated: status.filesUpdated,
              removed: status.filesRemoved
            })}
          </dd>
          <dt>{t('teamSyncDetailFolders')}</dt>
          <dd>{total === null ? status.foldersDone : `${status.foldersDone} / ${total}`}</dd>
          <dt>{t('teamSyncDetailUnavailable')}</dt>
          <dd>{status.itemsUnavailable}</dd>
          <dt>{t('teamSyncDetailId')}</dt>
          <dd>
            <code>{status.jobId.slice(0, 8)}</code>{' '}
            <Button type="button" variant="ghost" size="xs" onClick={() => void copyId()}>
              {copied ? t('teamSyncCopied') : t('teamSyncCopyId')}
            </Button>
          </dd>
        </dl>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
