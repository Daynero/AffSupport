import { useEffect, useRef, useState } from 'react';
import type { LaunchBatchCommand } from '@video-compressor/shared';
import { Accordion, Button, Card, Progress } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { teamErrorMessageFor } from '../errors.js';
import { useDurableLaunchBatches } from './useDurableLaunchBatches.js';
import { durableBatchPending, durableItemPending, durableItemState } from './durableBatchModel.js';
import { launchCardLabels } from './launchPresentation.js';
import type { DurableLaunchBatch } from '@video-compressor/shared';

/** A view of server-owned work. Unmounting this component never stops generation. */
export function LaunchBatch({
  teamId,
  actorId,
  command,
  reconcileEpoch = 0,
  enabled,
  onOpen,
  onSubmitted,
  onChange,
  onPendingChange,
  onSubmissionPendingChange,
  onBatches
}: {
  teamId: string;
  actorId: string;
  command: LaunchBatchCommand | null;
  reconcileEpoch?: number;
  enabled: boolean;
  onOpen: (id: string) => void;
  onSubmitted: (key: string) => void;
  onChange: () => void;
  onPendingChange: (value: boolean) => void;
  onSubmissionPendingChange: (value: boolean) => void;
  onBatches: (value: DurableLaunchBatch[]) => void;
}) {
  const { t, language } = useI18n();
  const state = useDurableLaunchBatches({
    teamId,
    actorId,
    command,
    reconcileEpoch,
    enabled,
    onSubmitted,
    onChanged: onChange
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const callbacks = useRef({ onPendingChange, onSubmissionPendingChange, onBatches });
  callbacks.current = { onPendingChange, onSubmissionPendingChange, onBatches };
  useEffect(() => {
    callbacks.current.onSubmissionPendingChange(Boolean(state.pendingCommand));
  }, [state.pendingCommand]);
  const latest = state.batches[0]?.id;
  useEffect(() => {
    if (latest) setOpen(old => new Set([...old, latest]));
  }, [latest]);
  useEffect(() => {
    callbacks.current.onPendingChange(state.pending || state.initialRead);
  }, [state.pending, state.initialRead]);
  useEffect(() => {
    callbacks.current.onBatches(state.batches);
  }, [state.batches]);
  if (!state.batches.length && !state.pendingCommand && !state.reconnecting && !state.error)
    return null;
  return (
    <section aria-label={t('launchesBulkWork')} className="flex min-w-0 flex-col gap-3">
      {state.pendingCommand && (
        <Card>
          <p role="status" className="m-0 text-label">
            {t('launchesBulkSubmitting', { count: state.pendingCommand.items.length })}
          </p>
        </Card>
      )}
      {state.reconnecting && (
        <p role="status" className="m-0 text-caption text-muted">
          {t('launchesBulkReconnecting')}
        </p>
      )}
      {state.error !== null && (
        <p role="alert" className="m-0 text-caption text-error-text">
          {teamErrorMessageFor(state.error, t)}
        </p>
      )}
      <Accordion
        openIds={open}
        onToggle={id =>
          setOpen(old => {
            const next = new Set(old);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        items={state.batches.map(batch => {
          const done = batch.items.filter(item => !durableItemPending(item)).length;
          const ready = batch.items.filter(item => durableItemState(item) === 'ready').length;
          const pending = durableBatchPending(batch);
          const canceling =
            Boolean(batch.cancelRequestedAt) || state.canceling.has(batch.requestKey);
          const stamp = new Intl.DateTimeFormat(language, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
          }).format(new Date(batch.createdAt));
          return {
            id: batch.id,
            title: t('launchesBulkSummary', { done, total: batch.items.length }),
            aside: <span className="text-caption text-muted">{stamp}</span>,
            content: (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-caption text-muted">
                    {t('launchesBulkReadyCount', { ready, total: batch.items.length })}
                  </span>
                  {pending && enabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={canceling}
                      onClick={() => state.cancel(batch)}
                    >
                      {t(canceling ? 'launchesBulkCanceling' : 'launchesBulkCancel')}
                    </Button>
                  )}
                </div>
                <Progress
                  value={(100 * done) / batch.items.length}
                  label={t('launchesProgressTitle')}
                  size="xs"
                />
                {pending && (
                  <p className="m-0 text-caption text-muted">{t('launchesBulkDurable')}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {batch.items.map(item => {
                    const itemState = durableItemState(item);
                    const color =
                      itemState === 'ready'
                        ? 'success'
                        : itemState === 'failed'
                          ? 'error'
                          : itemState === 'partial'
                            ? 'warning'
                            : itemState === 'running' || itemState === 'queued'
                              ? 'info'
                              : 'neutral';
                    const g = item.generation;
                    const video = g?.videoGeneration;
                    const progress = video
                      ? { completed: video.registeredCount, total: video.requestedCount }
                      : g?.progress;
                    return (
                      <div key={item.launchId} className="flex min-w-0 max-w-full flex-col gap-1">
                        <Button
                          size="sm"
                          className="launch-batch-item-button"
                          variant="soft"
                          color={color}
                          onClick={() => onOpen(item.launchId)}
                        >
                          {item.offer || '—'} · {item.social || '—'} · {t('launchesAccount')}{' '}
                          {item.agentSuffix || item.agentId.slice(-3) || '—'} ·{' '}
                          {t(
                            itemState === 'canceled'
                              ? 'teamAuditCanceled'
                              : launchCardLabels[itemState]
                          )}
                        </Button>
                        {durableItemPending(item) && progress && (
                          <span className="text-caption text-muted">
                            {video || g?.progress?.source === 'registered_video_variants'
                              ? t('catalogVideoCreationProgress', {
                                  ready: progress.completed,
                                  total: progress.total
                                })
                              : `${progress.completed} / ${progress.total}`}
                          </span>
                        )}
                        {(item.errorCode || item.cancelErrorCode) && (
                          <span
                            className={`text-caption ${item.admission === 'pending' && !item.cancelErrorCode ? 'text-muted' : 'text-error-text'}`}
                          >
                            {item.admission === 'pending' && !item.cancelErrorCode
                              ? t(
                                  item.errorCode === 'AGENT_REQUIRED'
                                    ? 'launchesBulkWaitingAgent'
                                    : item.errorCode === 'AGENT_UPDATE_REQUIRED'
                                      ? 'launchesBulkWaitingUpdate'
                                      : 'launchesBulkWaitingService'
                                )
                              : teamErrorMessageFor(
                                  { code: item.cancelErrorCode ?? item.errorCode },
                                  t
                                )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          };
        })}
      />
      {state.hasMore && (
        <Button
          size="sm"
          variant="ghost"
          disabled={state.loadingMore}
          onClick={() => void state.loadMore()}
        >
          {t('launchesBulkEarlier')}
        </Button>
      )}
    </section>
  );
}
