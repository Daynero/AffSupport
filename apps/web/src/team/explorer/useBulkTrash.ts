import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { withReadDeadline } from '../readCoordinator';
import { useCallback, useEffect, useRef, useState } from 'react';
import { teamErrorCodeOf } from '../errors';
import type {
  BulkTrashItem,
  BulkTrashGroup,
  TeamMaterialRow,
  TeamErrorCode
} from '@video-compressor/shared';
import { beginWorkspaceOperation, type WorkspaceStage } from '../workspace/operationAnalytics';
import { teamApi, TeamApiError } from '../../api/team';
import { trashMaterialWithTail, type TrashTailClient } from '../materials/tail';

export interface BulkTrashClient {
  prepareBulkTrashItem: typeof teamApi.prepareBulkTrashItem;
  listBulkTrash: typeof teamApi.listBulkTrash;
  startBulkTrash: typeof teamApi.startBulkTrash;
  markBulkTrashRequest: typeof teamApi.markBulkTrashRequest;
}
/** All successes come from hosted receipts, never from local intent or HTTP acceptance. */
export function useBulkTrash(
  teamId: string,
  revision: number,
  client: BulkTrashClient = teamApi,
  actorId?: string
) {
  const [groups, setGroups] = useState<BulkTrashGroup[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(new Set<string>());
  const starting = useRef<string | null>(null);
  const currentTeam = useRef(teamId);
  currentTeam.current = teamId;
  const generation = useRef(0);
  const readId = useRef(0);
  const observed = useRef(new Map<string, ReturnType<typeof beginWorkspaceOperation>>());
  const lastStage = useRef(new Map<string, string>());
  const reportStage = useCallback((id: string, stage: WorkspaceStage, code?: TeamErrorCode) => {
    const flow = observed.current.get(id);
    const fingerprint = `${stage}:${code ?? ''}`;
    if (!flow || lastStage.current.get(id) === fingerprint) return;
    lastStage.current.set(id, fingerprint);
    flow.stage(stage, code);
  }, []);
  useEffect(() => {
    for (const group of groups.filter(group => group.teamId === teamId)) {
      let flow = observed.current.get(group.id);
      if (!flow) {
        flow = beginWorkspaceOperation('bulk_trash', group.id, group.items.length, undefined, true);
        observed.current.set(group.id, flow);
      }
      const unknown = group.items.find(item => item.state === 'unknown');
      const failed = group.items.find(item => item.state === 'failed');
      if (group.items.every(item => item.state === 'confirmed')) reportStage(group.id, 'confirmed');
      else if (unknown)
        reportStage(group.id, 'unknown', teamErrorCodeOf({ code: unknown.errorCode }) ?? undefined);
      else if (failed)
        reportStage(group.id, 'partial', teamErrorCodeOf({ code: failed.errorCode }) ?? undefined);
      else reportStage(group.id, 'running');
    }
  }, [groups, teamId, reportStage]);
  useEffect(() => {
    generation.current++;
    setGroups([]);
    active.current.clear();
    starting.current = null;
    observed.current.clear();
    lastStage.current.clear();
    return () => {
      generation.current++;
    };
  }, [teamId, actorId, client]);
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
          currentTeam.current === teamId &&
          current === generation.current &&
          read === readId.current
        ) {
          setGroups(receipts);
          setUncertain(false);
        }
        return receipts;
      } catch (cause) {
        if (
          !signal.aborted &&
          currentTeam.current === teamId &&
          current === generation.current &&
          read === readId.current
        )
          setUncertain(true);
        throw cause;
      }
    },
    [client, teamId]
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
  const execute = useCallback(
    async (
      group: BulkTrashGroup,
      rows: readonly TeamMaterialRow[],
      tailClient: TrashTailClient
    ) => {
      if (currentTeam.current !== teamId || active.current.has(group.id)) return;
      active.current.add(group.id);
      const current = generation.current;
      try {
        // Reconcile before replay: a missing response cannot make a second operation key.
        const receipts = await refresh();
        const authoritative = receipts.find(receipt => receipt.id === group.id) ?? group;
        const pending = authoritative.items.filter(item =>
          ['queued', 'failed', 'unknown'].includes(item.state)
        );
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, pending.length) }, async () => {
            while (
              index < pending.length &&
              currentTeam.current === teamId &&
              current === generation.current
            ) {
              let item: BulkTrashItem | undefined = pending[index++];
              if (!item) continue;
              const row = rows.find(candidate => candidate.id === item?.materialId);
              try {
                const prepared = await client.prepareBulkTrashItem(
                  teamId,
                  group.id,
                  item.materialId
                );
                item = prepared.items.find(candidate => candidate.materialId === item?.materialId);
                if (!item || item.state === 'confirmed' || item.state === 'running') continue;
                await client.markBulkTrashRequest(teamId, group.id, item.materialId);
                await trashMaterialWithTail({
                  teamId,
                  material: {
                    id: item.materialId,
                    name: row?.name ?? '',
                    category: row?.category ?? null
                  },
                  client: tailClient,
                  idempotencyKey: item.idempotencyKey
                });
              } catch (cause) {
                if (currentTeam.current !== teamId || current !== generation.current) return;
                const code = teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE';
                // A request failure does not establish a server failure. Reconcile its exact receipt.
                if (item)
                  await client
                    .markBulkTrashRequest(teamId, group.id, item.materialId, code)
                    .catch(() => undefined);
              }
              if (currentTeam.current !== teamId || current !== generation.current) return;
              await refresh().catch(cause => {
                if (currentTeam.current !== teamId || current !== generation.current) return;
                reportStage(group.id, 'unknown', teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE');
              });
            }
          })
        );
      } finally {
        if (current === generation.current) active.current.delete(group.id);
      }
    },
    [client, refresh, reportStage, teamId]
  );
  const start = useCallback(
    async (rows: readonly TeamMaterialRow[], tailClient: TrashTailClient) => {
      if (currentTeam.current !== teamId)
        throw new DOMException('Bulk trash scope ended', 'AbortError');
      if (starting.current === teamId) throw new TeamApiError('WRONG_STATE', true);
      const current = generation.current;
      starting.current = teamId;
      const groupId = crypto.randomUUID();
      const flow = beginWorkspaceOperation('bulk_trash', groupId, rows.length);
      observed.current.set(groupId, flow);
      try {
        const existing = await refresh();
        if (current !== generation.current || currentTeam.current !== teamId)
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        const busy = new Set(
          existing.flatMap(group =>
            group.items
              .filter(item => ['queued', 'running', 'unknown'].includes(item.state))
              .map(item => item.materialId)
          )
        );
        if (rows.some(row => busy.has(row.id))) throw new TeamApiError('WRONG_STATE', true);
        const group = await client.startBulkTrash(
          teamId,
          groupId,
          rows.map(row => row.id)
        );
        if (current !== generation.current || currentTeam.current !== teamId)
          throw new DOMException('Bulk trash scope ended', 'AbortError');
        flow.stage('accepted');
        await refresh();
        void execute(group, rows, tailClient).catch(() => {
          if (current === generation.current) setUncertain(true);
        });
        return group;
      } catch (cause) {
        if (current === generation.current) flow.fail(cause);
        throw cause;
      } finally {
        if (current === generation.current && starting.current === teamId) starting.current = null;
      }
    },
    [client, execute, refresh, teamId]
  );
  const acknowledgeVisible = useCallback((id: string) => {
    const flow = observed.current.get(id);
    flow?.visible();
  }, []);
  return {
    groups: groups.filter(group => group.teamId === teamId),
    uncertain,
    start,
    retry: execute,
    refresh,
    acknowledgeVisible,
    owns: (group: BulkTrashGroup) => actorId === undefined || group.actorId === actorId
  };
}
