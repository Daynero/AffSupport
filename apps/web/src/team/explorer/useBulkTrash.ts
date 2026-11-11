import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { withReadDeadline } from '../readCoordinator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { WorkspaceMutationJournal } from '../workspace/mutationJournal';
import { withCatalogCommandDeadline as withMutationDeadline } from '../catalog-updater/catalogCommandCoordinator';
import { teamErrorCodeOf } from '../errors';
import type {
  BulkTrashItem,
  BulkTrashGroup,
  TeamMaterialRow,
  TeamErrorCode,
  TeamHistoricalFileReceipt
} from '@video-compressor/shared';
import {
  beginWorkspaceOperation,
  type WorkspaceStage,
  type WorkspaceDiagnosticSource
} from '../workspace/operationAnalytics';
import { parseTeamFileOperationResult } from '@video-compressor/shared';
import { teamApi, TeamApiError } from '../../api/team';
import { trashMaterialWithTail, type TrashTailClient } from '../materials/tail';

export interface BulkTrashClient {
  prepareBulkTrashItem: typeof teamApi.prepareBulkTrashItem;
  listBulkTrash: typeof teamApi.listBulkTrash;
  startBulkTrash: typeof teamApi.startBulkTrash;
  markBulkTrashRequest: typeof teamApi.markBulkTrashRequest;
  /** Optional so an older client keeps hiding in memory only. */
  dismissBulkTrash?: typeof teamApi.dismissBulkTrash;
}
/** All successes come from hosted receipts, never from local intent or HTTP acceptance. */
export function useBulkTrash(
  teamId: string,
  revision: number,
  client: BulkTrashClient = teamApi,
  actorId?: string
) {
  const [groups, setGroups] = useState<BulkTrashGroup[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  /** Groups this tab is executing right now: a retry would only be ignored. */
  const [executing, setExecuting] = useState<ReadonlySet<string>>(() => new Set());
  /** Names the starting surface knew; receipts never carry them. */
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  /**
   * Surfaces that show a group themselves (the catalog manager, with catalog
   * names and its own retry). Every other surface leaves those groups to them,
   * so one operation is reported by exactly one panel.
   */
  const [claims, setClaims] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [uncertain, setUncertain] = useState(false);
  const [historicalReceipts, setHistoricalReceipts] = useState<
    ReadonlyMap<string, ReadonlyMap<string, TeamHistoricalFileReceipt>>
  >(new Map());
  const historicalRef = useRef(historicalReceipts);
  historicalRef.current = historicalReceipts;
  const active = useRef(new Set<string>());
  const starting = useRef<string | null>(null);
  const mutationControllers = useRef(new Set<AbortController>());
  const epoch = usePrivateCacheEpoch();
  const originatingActor = actorId ?? privateCacheActor();
  const mutationJournal = useCallback(() => {
    if (!originatingActor) throw new TeamApiError('AUTH_REQUIRED', false);
    return new WorkspaceMutationJournal('bulk-trash', originatingActor, teamId, localStorage);
  }, [originatingActor, teamId]);
  const scope = useMemo(
    () => ({ teamId, actorId, client, epoch }),
    [teamId, actorId, client, epoch]
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const liveScope = useRef<typeof scope | null>(scope);
  const scopeCurrent = useCallback(
    () =>
      currentScope.current === scope &&
      liveScope.current === scope &&
      privateCacheEpoch() === epoch,
    [scope, epoch]
  );
  const waitMutation = useCallback(
    async <T>(work: (signal: AbortSignal) => Promise<T>) => {
      if (!scopeCurrent()) throw new DOMException('Bulk trash scope ended', 'AbortError');
      const controller = new AbortController();
      mutationControllers.current.add(controller);
      try {
        return await withMutationDeadline(work, controller.signal);
      } finally {
        mutationControllers.current.delete(controller);
      }
    },
    [scopeCurrent]
  );
  const generation = useRef(0);
  const readId = useRef(0);
  const observed = useRef(new Map<string, ReturnType<typeof beginWorkspaceOperation>>());
  const lastStage = useRef(new Map<string, string>());
  const historicalFlows = useRef(new Set<string>());
  const reportStage = useCallback(
    (id: string, stage: WorkspaceStage, code?: TeamErrorCode) => {
      if (!scopeCurrent()) return;
      const flow = observed.current.get(id);
      const fingerprint = `${stage}:${code ?? ''}`;
      if (!flow || lastStage.current.get(id) === fingerprint) return;
      lastStage.current.set(id, fingerprint);
      flow.stage(stage, code);
    },
    [scopeCurrent]
  );
  useEffect(() => {
    if (!scopeCurrent()) return;
    for (const group of groups.filter(group => group.teamId === teamId)) {
      let flow = observed.current.get(group.id);
      const historical = historicalReceipts.has(group.id);
      if (!historical) historicalFlows.current.delete(group.id);
      if (!flow || (historical && !historicalFlows.current.has(group.id))) {
        flow = beginWorkspaceOperation('bulk_trash', group.id, group.items.length, undefined, true);
        observed.current.set(group.id, flow);
        lastStage.current.delete(group.id);
        if (historical) historicalFlows.current.add(group.id);
      }
      const unknown = group.items.find(item => item.state === 'unknown');
      const failed = group.items.find(item => item.state === 'failed');
      if (historicalReceipts.has(group.id))
        reportStage(group.id, 'unknown', 'PROCESS_RESULT_UNCERTAIN');
      else if (group.items.every(item => item.state === 'confirmed'))
        reportStage(group.id, 'confirmed');
      else if (unknown)
        reportStage(group.id, 'unknown', teamErrorCodeOf({ code: unknown.errorCode }) ?? undefined);
      else if (failed)
        reportStage(group.id, 'partial', teamErrorCodeOf({ code: failed.errorCode }) ?? undefined);
      else reportStage(group.id, 'running');
    }
  }, [groups, teamId, reportStage, scopeCurrent, historicalReceipts]);
  useEffect(() => {
    liveScope.current = scope;
    generation.current++;
    setGroups([]);
    setHistoricalReceipts(new Map());
    setDismissed(new Set());
    setExecuting(new Set());
    setNames(new Map());
    active.current.clear();
    starting.current = null;
    observed.current.clear();
    lastStage.current.clear();
    historicalFlows.current.clear();
    return () => {
      generation.current++;
      for (const controller of mutationControllers.current) controller.abort();
      mutationControllers.current.clear();
      if (liveScope.current === scope) liveScope.current = null;
    };
  }, [scope]);
  const readReceipts = useCallback(
    async (signal: AbortSignal) => {
      const current = generation.current;
      const read = ++readId.current;
      try {
        const receipts = await withReadDeadline(
          child => client.listBulkTrash(teamId, { signal: child }),
          signal
        );
        if (
          !signal.aborted &&
          scopeCurrent() &&
          current === generation.current &&
          read === readId.current
        ) {
          let localUnknown = false;
          if (originatingActor)
            try {
              const journal = mutationJournal();
              for (const group of receipts) {
                if (
                  group.actorId === originatingActor &&
                  group.items.length > 0 &&
                  group.items.every(item => item.state === 'confirmed')
                )
                  journal.confirmed(group.id);
              }
              localUnknown = journal
                .list()
                .some(intent => !receipts.some(group => group.id === intent.id));
            } catch {
              // A local journal failure cannot hide authoritative hosted receipts.
              localUnknown = true;
            }
          setHistoricalReceipts(previous => {
            const next = new Map<string, ReadonlyMap<string, TeamHistoricalFileReceipt>>();
            for (const group of receipts) {
              const items = new Map<string, TeamHistoricalFileReceipt>();
              for (const item of group.items) {
                if (item.historicalReceipt) items.set(item.materialId, item.historicalReceipt);
                else if (item.state !== 'confirmed') {
                  const retained = previous.get(group.id)?.get(item.materialId);
                  if (retained) items.set(item.materialId, retained);
                }
              }
              if (items.size) next.set(group.id, items);
            }
            historicalRef.current = next;
            return next;
          });
          setGroups(receipts);
          setUncertain(localUnknown);
        }
        return receipts;
      } catch (cause) {
        if (
          !signal.aborted &&
          scopeCurrent() &&
          current === generation.current &&
          read === readId.current
        )
          setUncertain(true);
        throw cause;
      }
    },
    [client, teamId, scopeCurrent, mutationJournal, originatingActor]
  );
  const requestReceipts = useVisibleSerialRead({
    scopeKey: JSON.stringify([teamId, actorId]),
    client,
    revision,
    manualWhenHidden: true,
    bindScope: true,
    immediate: true,
    read: readReceipts
  });
  const refresh = useCallback(async () => {
    const receipts = await requestReceipts();
    if (receipts === undefined) throw new DOMException('Bulk trash scope ended', 'AbortError');
    return receipts;
  }, [requestReceipts]);
  const remember = useCallback((rows: readonly Pick<TeamMaterialRow, 'id' | 'name'>[]) => {
    if (!rows.some(row => row.name)) return;
    setNames(previous => {
      const next = new Map(previous);
      for (const row of rows) if (row.name) next.set(row.id, row.name);
      return next;
    });
  }, []);
  const execute = useCallback(
    async (
      group: BulkTrashGroup,
      rows: readonly Pick<TeamMaterialRow, 'id' | 'name' | 'category'>[],
      tailClient: TrashTailClient
    ) => {
      if (!scopeCurrent() || active.current.has(group.id)) return;
      active.current.add(group.id);
      setExecuting(new Set(active.current));
      remember(rows);
      const current = generation.current;
      try {
        // Reconcile before replay: a missing response cannot make a second operation key.
        const receipts = await refresh();
        if (!scopeCurrent() || current !== generation.current)
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        const authoritative = receipts.find(receipt => receipt.id === group.id);
        if (!authoritative) {
          // A retained browser intent is not hosted authority. Missing readback
          // remains unknown and must not dispatch the old group again.
          setUncertain(true);
          reportStage(group.id, 'unknown', 'PROCESS_RESULT_UNCERTAIN');
          throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', false);
        }
        const pending = authoritative.items.filter(
          item =>
            ['queued', 'failed', 'unknown'].includes(item.state) &&
            !historicalRef.current.get(group.id)?.has(item.materialId)
        );
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, pending.length) }, async () => {
            while (index < pending.length && scopeCurrent() && current === generation.current) {
              let item: BulkTrashItem | undefined = pending[index++];
              if (!item) continue;
              const materialId = item.materialId;
              const row = rows.find(candidate => candidate.id === item?.materialId);
              let source: WorkspaceDiagnosticSource = 'trash_prepare';
              let historical: TeamHistoricalFileReceipt | undefined;
              try {
                const prepared = await waitMutation(() =>
                  client.prepareBulkTrashItem(teamId, group.id, materialId)
                );
                if (!scopeCurrent() || current !== generation.current) return;
                item = prepared.items.find(candidate => candidate.materialId === item?.materialId);
                if (!item || item.state === 'confirmed' || item.state === 'running') continue;
                const acceptedItem = item;
                source = 'trash_mark_request';
                await waitMutation(() => client.markBulkTrashRequest(teamId, group.id, materialId));
                if (!scopeCurrent() || current !== generation.current) return;
                source = 'trash_request';
                await waitMutation(signal =>
                  trashMaterialWithTail({
                    teamId,
                    material: {
                      id: acceptedItem.materialId,
                      name: row?.name ?? '',
                      category: row?.category ?? null
                    },
                    client: {
                      trashMaterial: async input => {
                        if (signal.aborted || !scopeCurrent() || current !== generation.current)
                          throw new DOMException('Bulk trash scope ended', 'AbortError');
                        const result = await tailClient.trashMaterial({
                          ...input,
                          receiptProtocol: 2,
                          expectedActorId: authoritative.actorId
                        });
                        const parsed = parseTeamFileOperationResult(result);
                        if (
                          parsed?.historicalReceipt &&
                          (parsed.materialId !== materialId ||
                            parsed.historicalReceipt.action !== 'trash')
                        )
                          throw new TeamApiError('INVALID_RESPONSE', false);
                        historical = parsed?.historicalReceipt;
                        return result;
                      }
                    },
                    idempotencyKey: acceptedItem.idempotencyKey
                  })
                );
              } catch (cause) {
                if (!scopeCurrent() || current !== generation.current) return;
                if (historical) {
                  const receipt = historical;
                  setHistoricalReceipts(previous => {
                    const next = new Map(previous),
                      items = new Map(next.get(group.id));
                    items.set(materialId, receipt);
                    next.set(group.id, items);
                    historicalRef.current = next;
                    return next;
                  });
                  reportStage(group.id, 'unknown', 'PROCESS_RESULT_UNCERTAIN');
                } else {
                  observed.current.get(group.id)?.diagnostic(source, cause);
                  const code = teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE';
                  // A request failure does not establish a server failure. Reconcile its exact receipt.
                  if (item)
                    await waitMutation(() =>
                      client.markBulkTrashRequest(teamId, group.id, materialId, code)
                    ).catch(() => undefined);
                }
              }
              if (!scopeCurrent() || current !== generation.current) return;
              await refresh().catch(cause => {
                if (!scopeCurrent() || current !== generation.current) return;
                observed.current.get(group.id)?.diagnostic('trash_reconcile', cause);
                reportStage(group.id, 'unknown', teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE');
              });
            }
          })
        );
      } catch (cause) {
        if (current === generation.current && scopeCurrent())
          observed.current.get(group.id)?.diagnostic('trash_refresh', cause);
        throw cause;
      } finally {
        if (current === generation.current && scopeCurrent()) {
          active.current.delete(group.id);
          setExecuting(new Set(active.current));
        }
      }
    },
    [client, refresh, remember, reportStage, teamId, scopeCurrent, waitMutation]
  );
  const start = useCallback(
    async (
      rows: readonly Pick<TeamMaterialRow, 'id' | 'name' | 'category'>[],
      tailClient: TrashTailClient
    ) => {
      if (!scopeCurrent()) throw new DOMException('Bulk trash scope ended', 'AbortError');
      if (starting.current === teamId) throw new TeamApiError('WRONG_STATE', true);
      const current = generation.current;
      const intent = mutationJournal().acquire(rows.map(row => row.id));
      starting.current = teamId;
      remember(rows);
      const groupId = intent.id;
      const flow = beginWorkspaceOperation('bulk_trash', groupId, rows.length);
      observed.current.set(groupId, flow);
      let source: WorkspaceDiagnosticSource = 'trash_refresh';
      try {
        const existing = await refresh();
        if (current !== generation.current || !scopeCurrent())
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        const busy = new Set(
          existing
            .filter(group => group.id !== groupId)
            .flatMap(group =>
              group.items
                .filter(item => ['queued', 'running', 'unknown'].includes(item.state))
                .map(item => item.materialId)
            )
        );
        source = 'trash_overlap';
        if (rows.some(row => busy.has(row.id))) throw new TeamApiError('WRONG_STATE', true);
        source = 'trash_start';
        const group = await waitMutation(() =>
          client.startBulkTrash(
            teamId,
            groupId,
            intent.materialIds,
            originatingActor ? { expectedActorId: originatingActor } : undefined
          )
        );
        if (current !== generation.current || !scopeCurrent())
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        flow.stage('accepted');
        // The hosted acknowledgement survives a failed/lagging receipt read.
        const retainAcknowledged = () => {
          if (current !== generation.current || !scopeCurrent()) return;
          setGroups(groups => [...groups.filter(item => item.id !== group.id), group]);
          setUncertain(true);
        };
        setGroups(groups => [...groups.filter(item => item.id !== group.id), group]);
        source = 'trash_reconcile';
        let fresh: BulkTrashGroup[];
        try {
          fresh = await refresh();
        } catch (cause) {
          if (current !== generation.current || !scopeCurrent())
            throw new DOMException('Bulk trash scope ended', 'AbortError');
          retainAcknowledged();
          flow.diagnostic('trash_reconcile', cause);
          flow.stage('unknown', teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE');
          return group;
        }
        if (current !== generation.current || !scopeCurrent())
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        if (!fresh.some(item => item.id === group.id)) {
          retainAcknowledged();
          flow.stage('unknown', 'PROCESS_RESULT_UNCERTAIN');
          return group;
        }
        void execute(group, rows, tailClient).catch(() => {
          if (current === generation.current && scopeCurrent()) setUncertain(true);
        });
        return group;
      } catch (cause) {
        if (current === generation.current && scopeCurrent()) {
          flow.diagnostic(source, cause);
          if (source === 'trash_start') {
            setUncertain(true);
            flow.stage('unknown', teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE');
          } else flow.fail(cause);
        }
        throw cause;
      } finally {
        if (current === generation.current && scopeCurrent() && starting.current === teamId)
          starting.current = null;
      }
    },
    [
      client,
      execute,
      refresh,
      remember,
      teamId,
      originatingActor,
      scopeCurrent,
      mutationJournal,
      waitMutation
    ]
  );
  const acknowledgeVisible = useCallback(
    (id: string, outcome?: 'unknown') => {
      if (!scopeCurrent()) return;
      let flow = observed.current.get(id);
      // Child visibility effects may run before the parent's receipt observer.
      // Own the visible attempt here as well, and never reuse a settled normal
      // success to hide a later historical/current-state explanation.
      if (!flow || (outcome === 'unknown' && !historicalFlows.current.has(id))) {
        flow = beginWorkspaceOperation(
          'bulk_trash',
          id,
          groupsRef.current.find(group => group.id === id)?.items.length ?? 0,
          undefined,
          true
        );
        observed.current.set(id, flow);
        lastStage.current.delete(id);
        if (outcome === 'unknown') historicalFlows.current.add(id);
      }
      if (outcome === 'unknown') flow.visibleResult('unknown', 'PROCESS_RESULT_UNCERTAIN');
      else flow.visible();
    },
    [scopeCurrent]
  );
  const dismiss = useCallback(
    (id: string) => {
      if (!scopeCurrent()) return;
      setDismissed(current => new Set([...current, id]));
      // Hosted, so a reload or another device does not bring it back. A failed
      // write only costs the panel reappearing once; it never blocks hiding.
      void client.dismissBulkTrash?.(teamId, id).catch(() => undefined);
    },
    [client, teamId, scopeCurrent]
  );
  const claim = useCallback((ids: readonly string[]) => {
    const change = (delta: number) =>
      setClaims(previous => {
        const next = new Map(previous);
        for (const id of ids) {
          const count = (next.get(id) ?? 0) + delta;
          if (count > 0) next.set(id, count);
          else next.delete(id);
        }
        return next;
      });
    change(1);
    return () => change(-1);
  }, []);
  const claimed = useMemo(() => new Set(claims.keys()), [claims]);
  return {
    dismiss,
    historicalReceipts: scopeCurrent() ? historicalReceipts : new Map(),
    groups: scopeCurrent()
      ? groups.filter(
          group => group.teamId === teamId && !group.dismissed && !dismissed.has(group.id)
        )
      : [],
    executing,
    names,
    claim,
    claimed,
    uncertain: scopeCurrent() && uncertain,
    start,
    retry: execute,
    refresh,
    acknowledgeVisible,
    owns: (group: BulkTrashGroup) => actorId === undefined || group.actorId === actorId
  };
}
