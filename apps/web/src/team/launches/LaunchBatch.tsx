import { createReadCoordinator } from '../readCoordinator.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LAUNCH_BATCH_MAX_ITEMS,
  parseLaunchConfig,
  type LaunchDetail,
  type LaunchSummary
} from '@video-compressor/shared';
import { launchApi, TeamApiError } from '../../api/team.js';
import { Button, Card, Progress } from '../../components/ui/index.js';
import { useI18n, type TranslationKey } from '../../i18n.js';
import { teamErrorMessageFor } from '../errors.js';
import { useLaunchGeneration } from './useLaunchGeneration.js';
import { launchReply } from './reply.js';
import { launchAction, launchObservedGeneration, launchBatchAdmission } from './analytics.js';
import { privateCacheActor, privateCacheActorEpoch } from '../private-cache-scope.js';
import { admitBatchItems, type LaunchBatchItem, type BatchItemState } from './batchModel.js';
import { launchCardState } from './launchPresentation.js';

const labels: Record<BatchItemState, TranslationKey> = {
  queued: 'launchesBulkQueued',
  dispatching: 'launchesBusy',
  accepted: 'launchesBulkAccepted',
  completed: 'launchesReady',
  blocked: 'launchesBulkFailed',
  uncertain: 'launchesBulkUncertain',
  stopped: 'launchesBulkStopped'
};
export function LaunchBatch({
  batchId,
  teamId,
  initial,
  summaries,
  enabled,
  onChange,
  onOpen,
  onStates,
  onFinished
}: {
  batchId: string;
  teamId: string;
  initial: LaunchBatchItem[];
  summaries: LaunchSummary[];
  enabled: boolean;
  onChange: () => void;
  onOpen: (id: string) => void;
  onStates: (items: LaunchBatchItem[]) => void;
  onFinished: () => void;
}) {
  const { t } = useI18n();
  const owner = useRef({ actorId: privateCacheActor(), epoch: privateCacheActorEpoch() });
  const ownsScope = () =>
    owner.current.actorId === privateCacheActor() &&
    owner.current.epoch === privateCacheActorEpoch();
  const [items, setItems] = useState(() => admitBatchItems(initial, !enabled));
  const [stopped, setStopped] = useState(false);
  const [offPage, setOffPage] = useState<LaunchSummary[]>([]);
  const latestItems = useRef(items);
  latestItems.current = items;
  const latestSummaries = useRef(summaries);
  latestSummaries.current = summaries;
  const readOwner = useMemo(
    () =>
      createReadCoordinator(async signal => {
        const missing = latestItems.current
          .filter(
            i =>
              ['accepted', 'uncertain'].includes(i.state) &&
              !latestSummaries.current.some(s => s.id === i.source.id)
          )
          .map(i => i.source.id);
        if (!missing.length) return;
        const page = await launchReply(
          launchApi.list(teamId, { ids: missing }, LAUNCH_BATCH_MAX_ITEMS)
        );
        if (!signal.aborted) setOffPage(page.items);
      }),
    [teamId]
  );
  useEffect(() => {
    readOwner.start();
    return () => readOwner.stop();
  }, [readOwner]);
  // Reuse the list's observation/reconnect cadence; never add per-card timers.
  useEffect(() => {
    void readOwner.request().catch(() => undefined);
  }, [readOwner, summaries]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const callbacks = useRef({ onStates, onFinished });
  callbacks.current = { onStates, onFinished };
  const update = (id: string, state: BatchItemState, error?: string) => {
    setItems(old =>
      admitBatchItems(
        old.map(i => (i.source.id === id ? { ...i, state } : i)),
        stopped || !enabled || !ownsScope()
      )
    );
    if (error) setErrors(old => ({ ...old, [id]: error }));
  };
  useEffect(() => {
    setItems(old => admitBatchItems(old, stopped || !enabled || !ownsScope()));
  }, [stopped, enabled]);
  useEffect(() => {
    callbacks.current.onStates(items);
  }, [items]);
  const pending = items.some(i =>
    ['queued', 'dispatching', 'accepted', 'uncertain'].includes(i.state)
  );
  useEffect(() => {
    if (!pending) callbacks.current.onFinished();
  }, [pending]);
  const done = items.filter(
    i => !['queued', 'dispatching', 'accepted', 'uncertain'].includes(i.state)
  ).length;
  return (
    <Card aria-label={t('launchesBulkGenerate', { count: items.length })}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong role="status">{t('launchesBulkSummary', { done, total: items.length })}</strong>
          {items.some(i => i.state === 'queued') && (
            <Button size="sm" variant="outline" onClick={() => setStopped(true)}>
              {t('launchesBulkStop')}
            </Button>
          )}
        </div>
        <Progress
          value={(done / items.length) * 100}
          label={t('launchesProgressTitle')}
          size="xs"
        />
        <p className="m-0 text-label text-ink-muted">{t('launchesBulkScope')}</p>
        <div className="flex flex-wrap gap-2">
          {items.map(item => (
            <div key={item.source.id} className="flex flex-col gap-1">
              <Button
                size="sm"
                variant="soft"
                color={
                  item.state === 'blocked' || item.state === 'uncertain'
                    ? 'warning'
                    : item.state === 'completed'
                      ? 'success'
                      : 'neutral'
                }
                onClick={() => onOpen(item.source.id)}
              >
                {item.source.offer || item.source.creativeAlias} · {t(labels[item.state])}
              </Button>
              {errors[item.source.id] && (
                <span className="text-label text-error-text" role="alert">
                  {errors[item.source.id]}
                </span>
              )}
              {['dispatching', 'accepted', 'uncertain'].includes(item.state) && (
                <BatchWorker
                  batchId={batchId}
                  owner={owner.current}
                  item={item}
                  teamId={teamId}
                  enabled={enabled}
                  stopped={stopped}
                  summary={
                    summaries.find(s => s.id === item.source.id) ??
                    offPage.find(s => s.id === item.source.id)
                  }
                  update={update}
                  onChange={onChange}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
function BatchWorker({
  batchId,
  owner,
  item,
  teamId,
  enabled,
  stopped,
  summary,
  update,
  onChange
}: {
  batchId: string;
  owner: { actorId: string | null; epoch: number };
  item: LaunchBatchItem;
  teamId: string;
  enabled: boolean;
  stopped: boolean;
  summary?: LaunchSummary;
  update: (id: string, state: BatchItemState, error?: string) => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const latest = useRef({ update, onChange, enabled, stopped });
  latest.current = { update, onChange, enabled, stopped };
  const accepted = useRef<string | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const generation = useLaunchGeneration(
    teamId,
    detail => {
      if (!detail.generation) return;
      if (!accepted.current) launchBatchAdmission(batchId, item.flowId, detail.id, 'accepted');
      accepted.current = detail.generation.id;
      launchObservedGeneration(
        { flowId: item.flowId, launchId: detail.id, generationId: detail.generation.id },
        detail.generation
      );
      latest.current.update(
        item.source.id,
        finished(detail)
          ? detail.generation.state === 'succeeded'
            ? 'completed'
            : 'blocked'
          : 'accepted'
      );
      latest.current.onChange();
    },
    undefined,
    item.flowId
  );
  const runner = useRef(generation);
  runner.current = generation;
  useEffect(() => {
    if (started.current) return;
    if (!enabled || stopped) {
      latest.current.update(item.source.id, 'stopped');
      return;
    }
    started.current = true;
    launchBatchAdmission(batchId, item.flowId, item.source.id, 'started');
    const check = () => {
      if (
        !mounted.current ||
        !latest.current.enabled ||
        owner.actorId !== privateCacheActor() ||
        owner.epoch !== privateCacheActorEpoch()
      )
        throw new TeamApiError('PERMISSION_DENIED', false);
      if (latest.current.stopped) {
        launchBatchAdmission(batchId, item.flowId, item.source.id, 'cancelled');
        latest.current.update(item.source.id, 'stopped');
        return false;
      }
      return true;
    };
    void (async () => {
      const detail = await launchReply(launchApi.detail(teamId, item.source.id));
      if (!check()) return;
      if (detail.version !== item.source.version)
        throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
      if (detail.activeRevision || detail.generation) throw new TeamApiError('WRONG_STATE', false);
      const config = parseLaunchConfig(detail.draft);
      if (!config.ok) throw new TeamApiError('INVALID_INPUT', false);
      const sources =
        detail.expectedSourceSnapshot ??
        (await launchReply(launchApi.refreshSources(teamId, config.value)));
      if (!check()) return;
      await runner.current.generate(detail, config.value, sources, detail.version);
    })().catch(error => {
      if (!mounted.current) return;
      if (!runner.current.hasUnresolvedRequest && !accepted.current)
        launchBatchAdmission(batchId, item.flowId, item.source.id, 'failed');
      launchAction(
        { flowId: item.flowId, launchId: item.source.id },
        'generate',
        'blocked',
        error instanceof TeamApiError ? error.code : 'UNKNOWN'
      );
      latest.current.update(
        item.source.id,
        runner.current.hasUnresolvedRequest ? 'uncertain' : 'blocked',
        teamErrorMessageFor(error, t)
      );
      latest.current.onChange();
    });
  }, [batchId, teamId, item.source.id, item.source.version, item.flowId, enabled, stopped, t]);
  useEffect(() => {
    if (!accepted.current || summary?.generation?.id !== accepted.current) return;
    const state = launchCardState(summary);
    if (!['running', 'queued', 'unknown'].includes(state))
      latest.current.update(item.source.id, state === 'ready' ? 'completed' : 'blocked');
  }, [summary]);
  return item.state === 'uncertain' ? (
    <Button
      size="sm"
      variant="outline"
      disabled={generation.busy || !enabled}
      onClick={() => {
        void launchApi
          .detail(teamId, item.source.id)
          .then(detail =>
            runner.current.retry(
              detail,
              detail.draft,
              detail.expectedSourceSnapshot,
              detail.version
            )
          )
          .catch(e =>
            latest.current.update(item.source.id, 'uncertain', teamErrorMessageFor(e, t))
          );
      }}
    >
      {t('retry')}
    </Button>
  ) : null;
}
function finished(detail: LaunchDetail): boolean {
  const g = detail.generation;
  return Boolean(
    g &&
    ['succeeded', 'failed', 'canceled', 'partial', 'interrupted'].includes(g.state) &&
    (!g.videoGeneration || ['ready', 'canceled'].includes(g.videoGeneration.state))
  );
}
