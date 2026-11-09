import {
  beginCatalogUiFlow,
  type CatalogUiFlow,
  type CatalogUiStage,
  type CatalogUiFailure
} from './analytics';
import { teamErrorCodeOf } from '../errors';
import { useEffect, useRef, useState } from 'react';
import type { CatalogCommandReceipt, CatalogCommandRequest } from '@video-compressor/shared';
import { TeamApiError } from '../../api/team';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { CatalogCommandJournal } from './catalogCommandJournal';
import {
  CatalogCommandCoordinator,
  withCatalogCommandDeadline,
  type CommandOutcome,
  type CommandState
} from './catalogCommandCoordinator';

export interface CatalogCommandClient {
  requestCatalogUpdateCommand?: (
    teamId: string,
    actorId: string,
    input: CatalogCommandRequest
  ) => Promise<CatalogCommandReceipt>;
  getCatalogUpdateCommand?: (
    teamId: string,
    input: CatalogCommandRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogCommandReceipt | null>;
  cancelCatalogCommandIntent?: (
    teamId: string,
    actorId: string,
    input: CatalogCommandRequest
  ) => Promise<CatalogCommandReceipt>;
}
const unsupported = () => new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
const definiteRejection = (error: unknown) =>
  error instanceof TeamApiError &&
  [
    'AUTH_REQUIRED',
    'PERMISSION_DENIED',
    'SPACE_BLOCKED',
    'INVALID_INPUT',
    'NOT_FOUND',
    'WRONG_STATE',
    'STALE_RESULT',
    'CATALOG_UPDATE_RECONCILIATION_REQUIRED',
    'CATALOG_COMMAND_UNSUPPORTED'
  ].includes(error.code);

/** Only this owner resumes command receipts; refreshes keep the existing registry read owner. */
export function useCatalogCommands(input: {
  teamId: string;
  client: CatalogCommandClient;
  reloadFresh: () => Promise<boolean>;
  onConfirmed: (receipt: CatalogCommandReceipt, mode: 'request' | 'read' | 'cancel') => void;
}) {
  const epoch = usePrivateCacheEpoch();
  const owner = useRef<CatalogCommandCoordinator | null>(null);
  const callbacks = useRef(input);
  callbacks.current = input;
  const [states, setStates] = useState<CommandState[]>([]);
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const awaitingFresh = useRef(new Set<string>());
  const [error, setError] = useState<unknown>(null);
  const [deliveries, setDeliveries] = useState<
    Array<{ flow: CatalogUiFlow; failure?: CatalogUiFailure; failureStage?: CatalogUiStage }>
  >([]);
  useEffect(() => {
    if (!deliveries.length) return;
    for (const item of deliveries) {
      if (item.failure) item.flow.fail(item.failure, item.failureStage);
      else item.flow.complete();
    }
    setDeliveries([]);
  }, [deliveries]);
  const current = () =>
    privateCacheEpoch() === epoch &&
    callbacks.current.teamId === input.teamId &&
    callbacks.current.client === input.client;
  const observe = async (
    outcome: CommandOutcome,
    mode: 'request' | 'read' | 'cancel'
  ): Promise<CommandOutcome> => {
    const observerOwner = owner.current;
    if (!current() || outcome.kind !== 'confirmed') return outcome;
    const ids =
      outcome.receipt.status === 'accepted'
        ? outcome.receipt.items.map(item => item.catalogId)
        : [];
    ids.forEach(id => awaitingFresh.current.add(id));
    setRefreshing([...awaitingFresh.current]);
    callbacks.current.onConfirmed(outcome.receipt, mode);
    if (ids.length) {
      const loaded = await callbacks.current.reloadFresh().catch(() => false);
      if (current() && owner.current === observerOwner && loaded) {
        ids.forEach(id => awaitingFresh.current.delete(id));
        setRefreshing([...awaitingFresh.current]);
      }
    }
    return outcome;
  };
  const runObserved = async (
    intent: CatalogCommandRequest,
    mode: 'request' | 'read' | 'cancel',
    work: () => Promise<CommandOutcome>
  ) => {
    const flow = beginCatalogUiFlow(intent.sourceAttemptId !== undefined ? 'retry' : 'run', {
      parentFlowId: intent.commandId,
      count: intent.catalogIds.length
    });
    flow.stage(
      mode === 'read'
        ? 'readback_requested'
        : mode === 'cancel'
          ? 'command_cancel_requested'
          : 'command_requested'
    );
    const outcome = await work();
    if (!current() || outcome.kind === 'obsolete') return outcome;
    if (outcome.kind === 'confirmed')
      flow.stage(outcome.receipt.status === 'cancelled' ? 'command_cancelled' : 'command_accepted');
    const observation = observe(outcome, mode);
    setDeliveries(previous => [
      ...previous,
      {
        flow,
        failureStage:
          mode === 'read'
            ? 'readback_requested'
            : mode === 'cancel'
              ? 'command_cancel_requested'
              : 'command_requested',
        ...(outcome.kind === 'unknown'
          ? { failure: teamErrorCodeOf(outcome.error) ?? ('UNKNOWN' as const) }
          : outcome.kind === 'rejected'
            ? { failure: teamErrorCodeOf(outcome.error) ?? ('SAVE_FAILED' as const) }
            : {})
      }
    ]);
    return observation;
  };
  const observedRef = useRef(runObserved);
  observedRef.current = runObserved;
  useEffect(() => {
    let active = true;
    const actor = privateCacheActor();
    awaitingFresh.current.clear();
    setRefreshing([]);
    setStates([]);
    setError(null);
    if (!actor) {
      setError(new TeamApiError('AUTH_REQUIRED', false));
      return;
    }
    let coordinator: CatalogCommandCoordinator;
    try {
      const journal = new CatalogCommandJournal(actor, input.teamId, localStorage);
      coordinator = new CatalogCommandCoordinator({
        journal,
        request: intent => {
          if (!input.client.requestCatalogUpdateCommand) return Promise.reject(unsupported());
          return input.client.requestCatalogUpdateCommand(input.teamId, actor, intent);
        },
        read: (commandId, signal) => {
          const state = coordinator.states.get(commandId);
          if (!state || !input.client.getCatalogUpdateCommand) return Promise.reject(unsupported());
          return input.client.getCatalogUpdateCommand(input.teamId, state.intent, { signal });
        },
        cancel: intent => {
          if (!input.client.cancelCatalogCommandIntent) return Promise.reject(unsupported());
          return input.client.cancelCatalogCommandIntent(input.teamId, actor, intent);
        },
        wait: withCatalogCommandDeadline,
        definiteRejection,
        isCurrent: () => active && current(),
        changed: () => {
          if (active && current()) setStates([...coordinator.states.values()]);
        }
      });
      owner.current = coordinator;
      setStates([...coordinator.states.values()]);
      // One bounded resume pass, four reads at most; no command is re-executed on mount.
      const pending = [...coordinator.states.keys()];
      let next = 0;
      void Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (active && current() && next < pending.length) {
            const commandId = pending[next++]!;
            const intent = coordinator.states.get(commandId)!.intent;
            await observedRef.current(intent, 'read', () => coordinator.reconcile(commandId));
          }
        })
      );
    } catch (cause) {
      setError(cause);
      return;
    }
    return () => {
      active = false;
      coordinator.dispose();
      if (owner.current === coordinator) owner.current = null;
    };
  }, [input.teamId, input.client, epoch]);
  return {
    states,
    refreshing,
    error,
    blocked: (id: string) => Boolean(owner.current?.blocked(id) || awaitingFresh.current.has(id)),
    async submit(catalogIds: string[], sourceAttemptId?: string) {
      if (!current())
        return { kind: 'obsolete', error: new Error('SCOPE_CHANGED') } as CommandOutcome;
      const intent = {
        commandId: crypto.randomUUID(),
        catalogIds,
        ...(sourceAttemptId !== undefined ? { sourceAttemptId } : {}),
        createdAt: Date.now()
      };
      const coordinator = owner.current;
      return runObserved(intent, 'request', async () => {
        if (error || !coordinator) return { kind: 'rejected', error: error ?? unsupported() };
        if (catalogIds.some(id => awaitingFresh.current.has(id)))
          return { kind: 'rejected', error: new TeamApiError('WRONG_STATE', false) };
        return coordinator.submit(intent);
      });
    },
    async check(commandId: string) {
      if (!current() || !owner.current) return;
      const coordinator = owner.current;
      const intent = coordinator.states.get(commandId)?.intent;
      if (intent) return runObserved(intent, 'read', () => coordinator.reconcile(commandId));
    },
    async cancel(commandId: string) {
      if (!current() || !owner.current) return;
      const coordinator = owner.current;
      const intent = coordinator.states.get(commandId)?.intent;
      if (intent) return runObserved(intent, 'cancel', () => coordinator.cancel(commandId));
    },
    async refresh() {
      const observerOwner = owner.current;
      const loaded = await input.reloadFresh().catch(() => false);
      if (current() && owner.current === observerOwner && loaded) {
        awaitingFresh.current.clear();
        setRefreshing([]);
      }
    }
  };
}
