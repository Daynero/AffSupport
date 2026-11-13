import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseLaunchBatchCommand,
  type DurableLaunchBatch,
  type LaunchBatchCommand
} from '@video-compressor/shared';
import { batchMatchesCommand, launchBatchApi } from '../../api/launch-batches.js';
import { TeamApiError } from '../../api/team.js';
import { privateCacheActor, privateCacheActorEpoch } from '../private-cache-scope.js';
import { createReadCoordinator, withReadDeadline } from '../readCoordinator.js';
import { durableBatchPending, mergeDurableBatch } from './durableBatchModel.js';
import { launchBatchAdmission, launchObservedGeneration } from './analytics.js';

type Cursor = { createdAt: string; id: string };
type Outbox = { command: LaunchBatchCommand | null; cancellations: Record<string, string> };
const emptyOutbox = (): Outbox => ({ command: null, cancellations: {} });
function readOutbox(key: string, teamId: string, actorId: string): Outbox {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 65_536) return emptyOutbox();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('command' in value) || !('cancellations' in value))
      return emptyOutbox();
    const command = parseLaunchBatchCommand(value.command);
    const cancellations: Record<string, string> = {};
    if (value.cancellations && typeof value.cancellations === 'object')
      for (const [batch, cancel] of Object.entries(value.cancellations).slice(0, 20))
        if (
          /^[a-f0-9-]{36}$/iu.test(batch) &&
          typeof cancel === 'string' &&
          /^[a-f0-9-]{36}$/iu.test(cancel)
        )
          cancellations[batch] = cancel;
    return {
      command: command?.teamId === teamId && command.expectedActorId === actorId ? command : null,
      cancellations
    };
  } catch {
    return emptyOutbox();
  }
}

/** The workspace cadence only observes/reconciles durable intent; it executes no media jobs. */
export function useDurableLaunchBatches({
  teamId,
  actorId,
  command,
  reconcileEpoch,
  enabled,
  onSubmitted,
  onChanged,
  client = launchBatchApi
}: {
  teamId: string;
  actorId: string;
  command: LaunchBatchCommand | null;
  reconcileEpoch: number;
  enabled: boolean;
  onSubmitted: (key: string) => void;
  onChanged: () => void;
  client?: typeof launchBatchApi;
}) {
  const storageKey = `soty:launch-batch-outbox:${actorId}:${teamId}`;
  const owner = useRef({ actorId, epoch: privateCacheActorEpoch() });
  const callbacks = useRef({ enabled, onSubmitted, onChanged });
  callbacks.current = { enabled, onSubmitted, onChanged };
  const [restored] = useState(() => readOutbox(storageKey, teamId, actorId));
  const outbox = useRef<Outbox>(restored);
  const [pendingCommand, setPendingCommand] = useState(outbox.current.command);
  const [canceling, setCanceling] = useState(
    () => new Set(Object.keys(outbox.current.cancellations))
  );
  const [batches, setBatches] = useState<DurableLaunchBatch[]>([]);
  const batchesRef = useRef(batches);
  const [initialRead, setInitialRead] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(false);
  const observed = useRef(new Map<string, string>());
  const admitted = useRef(new Set<string>());
  const settledRequests = useRef(new Set<string>());
  const retry = useRef({ next: 0, count: 0 });
  const cancelRetry = useRef(new Map<string, { next: number; count: number }>());
  const olderReadCursor = useRef(0);
  const head = useRef('');
  const cursorRevision = useRef(0);
  const moreRequest = useRef<AbortController | null>(null);
  const owns = useCallback(
    () =>
      mounted.current &&
      owner.current.actorId === privateCacheActor() &&
      owner.current.epoch === privateCacheActorEpoch(),
    []
  );
  const persist = useCallback(() => {
    try {
      if (!outbox.current.command && !Object.keys(outbox.current.cancellations).length)
        localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(outbox.current));
    } catch {
      /* Only opaque intent IDs/versions; server receipts remain authoritative without storage. */
    }
    setPendingCommand(outbox.current.command);
    setCanceling(new Set(Object.keys(outbox.current.cancellations)));
  }, [storageKey]);
  const observe = useCallback(
    (values: DurableLaunchBatch[]) => {
      if (!owns()) return;
      const next = new Map(batchesRef.current.map(batch => [batch.id, batch]));
      for (const batch of values) {
        const pending = outbox.current.command;
        const previous = next.get(batch.id);
        if (
          batch.teamId !== teamId ||
          (pending?.requestKey === batch.requestKey && !batchMatchesCommand(batch, pending)) ||
          (previous &&
            !batchMatchesCommand(batch, {
              teamId,
              expectedActorId: actorId,
              requestKey: previous.requestKey,
              items: previous.items
            }))
        )
          throw new TeamApiError('INVALID_RESPONSE', false);
      }
      for (const batch of values) {
        const merged = mergeDurableBatch(next.get(batch.id), batch);
        next.set(batch.id, merged);
        for (const item of merged.items) {
          const signature = `${item.admission}:${item.generation?.id}:${item.generation?.stateVersion}`;
          if (observed.current.get(item.childRequestKey) === signature) continue;
          observed.current.set(item.childRequestKey, signature);
          if (item.admission !== 'pending' && !admitted.current.has(item.childRequestKey)) {
            admitted.current.add(item.childRequestKey);
            launchBatchAdmission(
              batch.requestKey,
              item.childRequestKey,
              item.launchId,
              item.admission === 'accepted' ? 'accepted' : 'failed'
            );
          }
          if (item.generation)
            launchObservedGeneration(
              {
                flowId: item.childRequestKey,
                launchId: item.launchId,
                generationId: item.generation.id
              },
              item.generation
            );
        }
        if (batch.cancelRequestedAt) {
          delete outbox.current.cancellations[batch.requestKey];
          cancelRetry.current.delete(batch.requestKey);
        }
        if (outbox.current.command?.requestKey === batch.requestKey) {
          settledRequests.current.add(batch.requestKey);
          outbox.current.command = null;
          callbacks.current.onSubmitted(batch.requestKey);
          callbacks.current.onChanged();
        }
      }
      batchesRef.current = [...next.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      );
      setBatches(batchesRef.current);
      persist();
    },
    [owns, teamId, actorId, persist]
  );
  const coordinator = useMemo(
    () =>
      createReadCoordinator(async signal => {
        if (!owns()) return;
        let failed = false;
        const pending = outbox.current.command;
        if (callbacks.current.enabled && pending && Date.now() >= retry.current.next) {
          try {
            const receipt = await withReadDeadline(
              child => client.read(teamId, pending.requestKey, child),
              signal
            );
            if (!owns() || !callbacks.current.enabled) return;
            const accepted =
              receipt ??
              (await withReadDeadline(child => client.submit(pending, child), signal, 30_000));
            if (!owns()) return;
            if (!batchMatchesCommand(accepted, pending))
              throw new TeamApiError('INVALID_RESPONSE', false);
            observe([accepted]);
            retry.current = { next: 0, count: 0 };
            setError(null);
          } catch (cause) {
            if (!owns() || signal.aborted) return;
            failed = true;
            const definitive =
              cause instanceof TeamApiError &&
              [
                'PERMISSION_DENIED',
                'FORBIDDEN',
                'INVALID_INPUT',
                'LAUNCH_VERSION_CONFLICT'
              ].includes(cause.code);
            if (definitive) {
              settledRequests.current.add(pending.requestKey);
              outbox.current.command = null;
              persist();
              callbacks.current.onSubmitted(pending.requestKey);
              setError(cause);
            } else {
              retry.current.count++;
              retry.current.next =
                Date.now() + Math.min(300_000, 10_000 * 2 ** Math.min(retry.current.count - 1, 5));
            }
          }
        }
        for (const [key, cancelKey] of Object.entries(outbox.current.cancellations)
          .filter(([key]) => Date.now() >= (cancelRetry.current.get(key)?.next ?? 0))
          .slice(0, 2)) {
          if (!owns() || !callbacks.current.enabled) break;
          try {
            const receipt = await withReadDeadline(
              child => client.cancel(teamId, key, cancelKey, actorId, child),
              signal
            );
            if (owns()) {
              if (receipt.teamId !== teamId || receipt.requestKey !== key)
                throw new TeamApiError('INVALID_RESPONSE', false);
              observe([receipt]);
              callbacks.current.onChanged();
            }
          } catch (cause) {
            if (!owns() || signal.aborted) return;
            failed = true;
            if (
              cause instanceof TeamApiError &&
              ['PERMISSION_DENIED', 'FORBIDDEN', 'NOT_FOUND'].includes(cause.code)
            ) {
              delete outbox.current.cancellations[key];
              persist();
              setError(cause);
            } else {
              const count = (cancelRetry.current.get(key)?.count ?? 0) + 1;
              cancelRetry.current.set(key, {
                count,
                next: Date.now() + Math.min(300_000, 10_000 * 2 ** Math.min(count - 1, 5))
              });
            }
          }
        }
        let headIds = new Set<string>();
        try {
          const page = await withReadDeadline(child => client.list(teamId, null, child), signal);
          if (!owns()) return;
          observe(page.items);
          headIds = new Set(page.items.map(batch => batch.id));
          // A changed head can hide a gap before previously loaded pages. Restart
          // traversal from this head, retaining already observed rows and deduping.
          const signature = page.items.map(batch => batch.id).join(':');
          if (head.current !== signature || cursorRevision.current === 0) {
            head.current = signature;
            cursorRevision.current++;
            setCursor(page.nextCursor);
            setHasMore(page.hasMore);
          }
        } catch {
          if (!owns() || signal.aborted) return;
          failed = true;
        }
        try {
          const older = batchesRef.current.filter(
            batch => durableBatchPending(batch) && !headIds.has(batch.id)
          );
          if (older.length) {
            const selected = Array.from(
              { length: Math.min(2, older.length) },
              (_, i) => older[(olderReadCursor.current + i) % older.length]!
            );
            olderReadCursor.current = (olderReadCursor.current + selected.length) % older.length;
            const results = await Promise.allSettled(
              selected.map(batch =>
                withReadDeadline(child => client.read(teamId, batch.requestKey, child), signal)
              )
            );
            if (!owns()) return;
            for (const result of results)
              if (result.status === 'fulfilled' && result.value) {
                const expected = selected[results.indexOf(result)]!;
                if (result.value.requestKey !== expected.requestKey)
                  throw new TeamApiError('INVALID_RESPONSE', false);
                observe([result.value]);
              } else failed = true;
          }
        } catch {
          failed = true;
        }
        if (owns()) {
          setInitialRead(false);
          setReconnecting(failed);
        }
      }),
    [actorId, client, observe, owns, persist, teamId]
  );
  useEffect(() => {
    mounted.current = true;
    coordinator.start();
    return () => {
      mounted.current = false;
      coordinator.stop();
      moreRequest.current?.abort();
    };
  }, [coordinator]);
  useEffect(() => {
    if (
      command &&
      owns() &&
      enabled &&
      !outbox.current.command &&
      !settledRequests.current.has(command.requestKey) &&
      !batchesRef.current.some(batch => batch.requestKey === command.requestKey)
    ) {
      const parsed = parseLaunchBatchCommand(command);
      if (!parsed || parsed.teamId !== teamId || parsed.expectedActorId !== actorId) {
        setError(new TeamApiError('INVALID_INPUT', false));
        return;
      }
      outbox.current.command = parsed;
      retry.current = { next: 0, count: 0 };
      persist();
      for (const item of parsed.items)
        launchBatchAdmission(parsed.requestKey, item.childRequestKey, item.launchId, 'started');
    }
    void coordinator.request().catch(() => undefined);
  }, [command, reconcileEpoch, enabled, actorId, teamId, coordinator, owns, persist]);
  const cancel = useCallback(
    (batch: DurableLaunchBatch) => {
      if (
        !owns() ||
        !callbacks.current.enabled ||
        !durableBatchPending(batch) ||
        batch.cancelRequestedAt
      )
        return;
      outbox.current.cancellations[batch.requestKey] ??= crypto.randomUUID();
      persist();
      void coordinator.request().catch(() => undefined);
    },
    [coordinator, owns, persist]
  );
  const loadMore = async () => {
    if (!owns() || moreRequest.current || !hasMore || !cursor) return;
    setLoadingMore(true);
    const controller = new AbortController();
    const revision = cursorRevision.current;
    moreRequest.current = controller;
    try {
      const page = await withReadDeadline(
        signal => client.list(teamId, cursor, signal),
        controller.signal
      );
      if (!owns()) return;
      observe(page.items);
      if (revision === cursorRevision.current) {
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      }
    } catch (cause) {
      if (owns()) setError(cause);
    } finally {
      moreRequest.current = null;
      if (owns()) setLoadingMore(false);
    }
  };
  return {
    batches,
    pendingCommand,
    canceling,
    initialRead,
    reconnecting,
    error,
    hasMore,
    loadingMore,
    loadMore,
    cancel,
    pending:
      Boolean(pendingCommand) ||
      canceling.size > 0 ||
      reconnecting ||
      batches.some(durableBatchPending)
  };
}
