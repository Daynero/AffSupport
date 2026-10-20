import { useCallback, useEffect, useRef, useState } from 'react';
import { teamErrorCodeOf } from '../errors';
import type { BulkTrashItem, BulkTrashGroup, TeamMaterialRow } from '@video-compressor/shared';
import { beginWorkspaceOperation } from '../workspace/operationAnalytics';
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
  useEffect(() => {
    for (const group of groups.filter(group => group.teamId === teamId)) {
      let flow = observed.current.get(group.id);
      if (!flow) {
        flow = beginWorkspaceOperation('bulk_trash', group.id, group.items.length, undefined, true);
        observed.current.set(group.id, flow);
      }
      if (group.items.every(item => item.state === 'confirmed')) flow.stage('confirmed');
      else if (group.items.some(item => item.state === 'unknown')) flow.stage('unknown');
      else if (group.items.some(item => item.state === 'failed')) flow.stage('partial');
      else flow.stage('running');
    }
  }, [groups, teamId]);
  useEffect(() => {
    generation.current++;
    setGroups([]);
    active.current.clear();
    observed.current.clear();
  }, [teamId]);
  const refresh = useCallback(async () => {
    const current = generation.current;
    const read = ++readId.current;
    try {
      const receipts = await client.listBulkTrash(teamId);
      if (
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
        currentTeam.current === teamId &&
        current === generation.current &&
        read === readId.current
      )
        setUncertain(true);
      throw cause;
    }
  }, [client, teamId]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh, revision]);
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
                const code = teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE';
                observed.current.get(group.id)?.stage('unknown', code);
                // A request failure does not establish a server failure. Reconcile its exact receipt.
                if (item)
                  await client
                    .markBulkTrashRequest(teamId, group.id, item.materialId, code)
                    .catch(() => undefined);
              }
              await refresh().catch(() => undefined);
            }
          })
        );
      } finally {
        active.current.delete(group.id);
      }
    },
    [client, refresh, teamId]
  );
  const start = useCallback(
    async (rows: readonly TeamMaterialRow[], tailClient: TrashTailClient) => {
      if (starting.current === teamId) throw new TeamApiError('WRONG_STATE', true);
      starting.current = teamId;
      const groupId = crypto.randomUUID();
      const flow = beginWorkspaceOperation('bulk_trash', groupId, rows.length);
      observed.current.set(groupId, flow);
      try {
        const existing = await refresh();
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
        flow.stage('accepted');
        await refresh();
        void execute(group, rows, tailClient).catch(() => setUncertain(true));
        return group;
      } catch (cause) {
        flow.fail(cause);
        throw cause;
      } finally {
        if (starting.current === teamId) starting.current = null;
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
