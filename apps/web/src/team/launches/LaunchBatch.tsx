import { createReadCoordinator, isSoftReadFailure, withReadDeadline } from '../readCoordinator.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseLaunchConfig,
  type LaunchDetail,
  type LaunchGeneration,
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
import {
  admitBatchItems,
  batchPending,
  LAUNCH_BATCH_CONCURRENCY,
  type LaunchBatchItem,
  type BatchItemState
} from './batchModel.js';
import { launchCardState } from './launchPresentation.js';

const cancelPending = (g: LaunchGeneration) =>
  ['cancel_requested', 'canceled_with_cleanup_pending'].includes(g.state);
const labels: Record<BatchItemState, TranslationKey> = {
  queued: 'launchesBulkQueued',
  dispatching: 'launchesBusy',
  accepted: 'launchesBulkAccepted',
  completed: 'launchesReady',
  blocked: 'launchesBulkFailed',
  uncertain: 'launchesBulkUncertain',
  deferred: 'launchesBulkDeferred',
  partial: 'launchesBulkPartial',
  canceled: 'launchesProgressStopped',
  stopped: 'launchesBulkStopped'
};
export function LaunchBatch({
  batchId,
  teamId,
  initial,
  summaries,
  reconcileEpoch = 0,
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
  reconcileEpoch?: number;
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
  const latestItems = useRef(items);
  latestItems.current = items;
  const readers = useRef(new Map<string, (signal: AbortSignal) => Promise<void>>());
  const register = useCallback((id: string, read: (signal: AbortSignal) => Promise<void>) => {
    readers.current.set(id, read);
    return () => {
      readers.current.delete(id);
    };
  }, []);
  const cursor = useRef(0);
  const readOwner = useMemo(
    () =>
      createReadCoordinator(async signal => {
        // Fair, bounded readback independent of filters/list availability. Unknown jobs
        // retain their identities but cannot hold every healthy sibling hostage.
        const pending = latestItems.current.filter(
          i =>
            ['accepted', 'uncertain', 'deferred'].includes(i.state) &&
            readers.current.has(i.source.id)
        );
        if (!pending.length) return;
        const start = cursor.current % pending.length;
        const count = Math.min(2, pending.length);
        cursor.current = start + count;
        await Promise.allSettled(
          Array.from({ length: count }, (_, n) =>
            readers.current.get(pending[(start + n) % pending.length]!.source.id)!(signal)
          )
        );
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
  }, [readOwner, reconcileEpoch]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const callbacks = useRef({ onStates, onFinished });
  callbacks.current = { onStates, onFinished };
  const publish = (next: LaunchBatchItem[]) => {
    latestItems.current = next;
    setItems(next);
  };
  const update = (id: string, state: BatchItemState, error?: string) => {
    publish(
      admitBatchItems(
        latestItems.current.map(i => (i.source.id === id ? { ...i, state } : i)),
        stopped || !enabled || !ownsScope()
      )
    );
    setErrors(old => ({ ...old, [id]: error ?? '' }));
  };
  const reserveReplay = (id: string) => {
    if (stopped || !enabled || !ownsScope()) return false;
    const current = latestItems.current;
    const item = current.find(i => i.source.id === id);
    if (!item || !batchPending(item.state)) return false;
    if (item.state !== 'deferred') return true;
    if (
      current.some(i => i.state === 'queued') ||
      current.filter(i => ['dispatching', 'accepted', 'uncertain'].includes(i.state)).length >=
        LAUNCH_BATCH_CONCURRENCY
    )
      return false;
    // Reserve synchronously: two independent read replies cannot take the same slot.
    update(id, 'uncertain');
    return true;
  };
  useEffect(() => {
    publish(admitBatchItems(latestItems.current, stopped || !enabled || !ownsScope()));
  }, [stopped, enabled]);
  useEffect(() => {
    callbacks.current.onStates(items);
  }, [items]);
  const pending = items.some(i => batchPending(i.state));
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  useEffect(() => {
    if (!pending) callbacks.current.onFinished();
  }, [pending]);
  const done = items.filter(i => !batchPending(i.state)).length;
  return (
    <Card aria-label={t('launchesBulkGenerate', { count: items.length })}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong role="status">{t('launchesBulkSummary', { done, total: items.length })}</strong>
          {items.some(i => ['uncertain', 'deferred'].includes(i.state)) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void readOwner.request().catch(() => undefined);
              }}
            >
              {t('launchesBulkCheck')}
            </Button>
          )}
          {!stopped &&
            items.some(i =>
              ['queued', 'dispatching', 'uncertain', 'deferred'].includes(i.state)
            ) && (
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
        {items.some(i => i.state === 'deferred') && (
          <p className="m-0 text-label text-ink-muted">{t('launchesBulkDeferredHelp')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {items.map(item => (
            <div key={item.source.id} className="flex min-w-0 max-w-full flex-col gap-1">
              <Button
                size="sm"
                className="launch-batch-item-button"
                variant="soft"
                color={
                  ['blocked', 'uncertain', 'deferred', 'partial'].includes(item.state)
                    ? 'warning'
                    : item.state === 'completed'
                      ? 'success'
                      : 'neutral'
                }
                onClick={() => onOpen(item.source.id)}
              >
                {item.source.offer || item.source.creativeAlias} ·{' '}
                {item.source.accountName || item.source.social} · {t(labels[item.state])}
              </Button>
              {errors[item.source.id] && (
                <span className="text-label text-error-text" role="alert">
                  {errors[item.source.id]}
                </span>
              )}
              {batchPending(item.state) && item.state !== 'queued' && (
                <BatchWorker
                  batchId={batchId}
                  owner={owner.current}
                  item={item}
                  teamId={teamId}
                  enabled={enabled}
                  stopped={stopped}
                  summary={summaries.find(s => s.id === item.source.id)}
                  register={register}
                  reserveReplay={reserveReplay}
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
  register,
  reserveReplay,
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
  register: (id: string, read: (signal: AbortSignal) => Promise<void>) => () => void;
  reserveReplay: (id: string) => boolean;
  update: (id: string, state: BatchItemState, error?: string) => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const latest = useRef({ update, onChange, enabled, stopped, reserveReplay, state: item.state });
  latest.current = { update, onChange, enabled, stopped, reserveReplay, state: item.state };
  const accepted = useRef<string | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const observed = useRef<LaunchGeneration | null>(null);
  const failures = useRef(0);
  const replays = useRef(0);
  const nextRetry = useRef(0);
  const preflight = useRef(true);
  const executing = useRef(false);
  const reading = useRef(false);
  const ownsScope = () =>
    mounted.current &&
    owner.actorId === privateCacheActor() &&
    owner.epoch === privateCacheActorEpoch();
  const report = (g: LaunchGeneration) => {
    if (!ownsScope()) return;
    if (g.requestKey && g.requestKey !== item.flowId && g.id !== accepted.current) {
      failed(new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true));
      return;
    }
    const known = observed.current;
    if (
      known?.id === g.id &&
      /^\d+$/u.test(g.stateVersion) &&
      /^\d+$/u.test(known.stateVersion) &&
      BigInt(g.stateVersion) < BigInt(known.stateVersion)
    )
      return;
    observed.current = g;
    if (!accepted.current) launchBatchAdmission(batchId, item.flowId, item.source.id, 'accepted');
    accepted.current = g.id;
    if (
      known?.id !== g.id ||
      known.stateVersion !== g.stateVersion ||
      known.errorCode !== g.errorCode
    )
      launchObservedGeneration(
        { flowId: item.flowId, launchId: item.source.id, generationId: g.id },
        g
      );
    const state = launchCardState({ ...item.source, generation: g });
    latest.current.update(
      item.source.id,
      cancelPending(g)
        ? 'deferred'
        : state === 'ready'
          ? 'completed'
          : state === 'failed'
            ? 'blocked'
            : state === 'partial'
              ? 'partial'
              : state === 'canceled'
                ? 'canceled'
                : latest.current.state === 'deferred'
                  ? 'deferred'
                  : 'accepted',
      cancelPending(g) ? t('launchesCleanupPending') : undefined
    );
  };
  const failed = (error: unknown) => {
    if (!mounted.current) return;
    if (!ownsScope()) {
      latest.current.update(item.source.id, 'stopped');
      return;
    }
    // A durable terminal receipt beats a late failed POST/native reply.
    if (
      observed.current &&
      (cancelPending(observed.current) ||
        !['running', 'queued', 'unknown'].includes(
          launchCardState({ ...item.source, generation: observed.current })
        ))
    )
      return;
    const unresolved =
      runner.current.hasUnresolvedRequest ||
      Boolean(accepted.current) ||
      (preflight.current &&
        (isSoftReadFailure(error) || (error instanceof TeamApiError && error.retryable)));
    nextRetry.current = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(replays.current, 4));
    if (!unresolved) launchBatchAdmission(batchId, item.flowId, item.source.id, 'failed');
    launchAction(
      { flowId: item.flowId, launchId: item.source.id },
      'generate',
      'blocked',
      error instanceof TeamApiError ? error.code : 'UNKNOWN'
    );
    latest.current.update(
      item.source.id,
      unresolved ? (++failures.current >= 3 ? 'deferred' : 'uncertain') : 'blocked',
      teamErrorMessageFor(error, t)
    );
    latest.current.onChange();
  };
  const generation = useLaunchGeneration(
    teamId,
    detail => {
      if (!detail.generation || !ownsScope()) return;
      report(detail.generation);
      latest.current.onChange();
    },
    undefined,
    item.flowId,
    () => {
      if (!ownsScope() || !latest.current.enabled)
        throw new TeamApiError('PERMISSION_DENIED', false);
      if (latest.current.stopped) throw new TeamApiError('PROCESS_CANCELED', false);
    }
  );
  const runner = useRef(generation);
  runner.current = generation;
  const check = () => {
    if (!ownsScope() || !latest.current.enabled) throw new TeamApiError('PERMISSION_DENIED', false);
    if (latest.current.stopped) {
      launchBatchAdmission(batchId, item.flowId, item.source.id, 'cancelled');
      latest.current.update(item.source.id, 'stopped');
      return false;
    }
    return true;
  };
  const startFromDraft = async (detail: LaunchDetail) => {
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
    preflight.current = false;
    await runner.current.generate(detail, config.value, sources, detail.version);
  };
  const execute = (work: () => Promise<void>) => {
    executing.current = true;
    void work()
      .catch(failed)
      .finally(() => {
        executing.current = false;
      });
  };
  useEffect(() => {
    if (started.current) return;
    if (!enabled || stopped) {
      latest.current.update(item.source.id, 'stopped');
      return;
    }
    started.current = true;
    launchBatchAdmission(batchId, item.flowId, item.source.id, 'started');
    execute(async () =>
      startFromDraft(await launchReply(launchApi.detail(teamId, item.source.id)))
    );
  }, [batchId, teamId, item.source.id, item.source.version, item.flowId, enabled, stopped, t]);
  const reconcile = async (signal: AbortSignal) => {
    if (reading.current || !ownsScope() || signal.aborted) return;
    reading.current = true;
    try {
      const detail = await withReadDeadline(
        readSignal => launchApi.detail(teamId, item.source.id, null, readSignal),
        signal
      );
      if (!ownsScope() || signal.aborted) return;
      const g = detail.generation;
      const matches = g && (g.id === accepted.current || g.requestKey === item.flowId);
      if (matches) {
        failures.current = 0;
        const state = launchCardState({ ...item.source, generation: g });
        if (cancelPending(g) || !['running', 'queued', 'unknown'].includes(state)) {
          runner.current.observe(detail);
          report(g);
          latest.current.onChange();
          return;
        }
        report(g);
      } else if (g || accepted.current) {
        // Archived/replaced receipts never become fabricated success or a new generation.
        throw new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true);
      }
      if (executing.current || (!preflight.current && !runner.current.hasUnresolvedRequest)) return;
      if (latest.current.stopped || !latest.current.enabled) {
        latest.current.update(item.source.id, 'deferred', t('launchesBulkDeferred'));
        return;
      }
      if (Date.now() < nextRetry.current || !latest.current.reserveReplay(item.source.id)) return;
      latest.current.state = 'uncertain';
      replays.current++;
      // Backoff is capped in frequency, not lifetime: a restored service can
      // finish an unattended batch. Frozen admission keys are never replaced.
      execute(() =>
        preflight.current
          ? startFromDraft(detail)
          : runner.current.generate(
              detail,
              detail.draft,
              detail.expectedSourceSnapshot,
              detail.version
            )
      );
    } catch (error) {
      if (!signal.aborted && ownsScope()) failed(error);
    } finally {
      reading.current = false;
    }
  };
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  useEffect(
    () => register(item.source.id, signal => reconcileRef.current(signal)),
    [register, item.source.id]
  );
  useEffect(() => {
    const g = summary?.generation;
    if (!g || (g.id !== accepted.current && g.requestKey !== item.flowId)) return;
    if (
      !runner.current.hasUnresolvedRequest ||
      cancelPending(g) ||
      !['running', 'queued', 'unknown'].includes(launchCardState(summary))
    )
      runner.current.observe({ id: summary.id, version: summary.version, generation: g });
    report(g);
  }, [summary]);
  return null;
}
