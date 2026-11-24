import { useEffect, useRef } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { TeamApiError } from '../../api/team';
import type { useToasts } from '../../components/toast';
import type { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { withReadDeadline } from '../readCoordinator';
import { beginCatalogUiFlow, type CatalogUiFailure, type CatalogUiFlow } from './analytics';
import { withCatalogCommandDeadline } from './catalogCommandCoordinator';
import type { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import type { CatalogUpdaterDialogClient } from './CatalogUpdaterDialog';

type Owner = ReturnType<typeof captureCatalogMutationOwner>;
type Toasts = ReturnType<typeof useToasts>;

/**
 * Stopping a running update, and saying whether it stopped (out of the manager's dialog,
 * 070 T056).
 *
 * A stop is asked of the server and then *observed*: the round is read back, and only a round
 * that is gone (or replaced) counts as stopped. Every outcome is a toast tied to one analytics
 * flow, completed when the toast is on screen — so a stop nobody saw is not counted as one.
 */
export function useCatalogStop({
  teamId,
  client,
  owner,
  push,
  toasts,
  t,
  busyRef,
  withBusy,
  blocked
}: {
  teamId: string;
  client: CatalogUpdaterDialogClient;
  owner: Owner;
  push: Toasts['push'];
  toasts: Toasts['toasts'];
  t: ReturnType<typeof useI18n>['t'];
  busyRef: { current: Set<string> };
  withBusy: (
    ids: string[],
    work: () => Promise<void>,
    options?: { refreshOnFailure?: boolean; onFailure?: (error: unknown) => void }
  ) => Promise<void>;
  /** A row whose controls are waiting on another change (inline or a command). */
  blocked: (catalogId: string) => boolean;
}) {
  const stopControllers = useRef(new Set<AbortController>());
  const stopFlows = useRef(new Set<CatalogUiFlow>());
  const stopFeedback = useRef(new Map<number, { flow: CatalogUiFlow; error?: CatalogUiFailure }>());
  useEffect(
    () => () => {
      for (const controller of stopControllers.current) controller.abort();
      for (const flow of stopFlows.current) flow.cancel();
      stopFlows.current.clear();
      stopFeedback.current.clear();
    },
    []
  );
  useEffect(() => {
    if (!owner.current()) return;
    for (const toast of toasts) {
      const delivered = stopFeedback.current.get(toast.id);
      if (!delivered) continue;
      if (delivered.error) delivered.flow.fail(delivered.error, 'result_visible');
      else delivered.flow.complete();
      stopFeedback.current.delete(toast.id);
      stopFlows.current.delete(delivered.flow);
    }
  }, [toasts, owner]);

  const showStopFeedback = (
    flow: CatalogUiFlow,
    input: Parameters<typeof push>[0],
    error?: CatalogUiFailure
  ) => {
    if (!owner.current()) {
      flow.cancel();
      return;
    }
    const toastId = push(input);
    stopFeedback.current.set(toastId, { flow, error });
  };
  const observeStop = async (
    row: CatalogRegistryRow,
    flow: CatalogUiFlow,
    controller: AbortController,
    requestFlowId: string,
    accepted = false
  ) => {
    flow.stage('stop_readback_requested');
    let inactive = false;
    let readCode: CatalogUiFailure = 'PROCESS_RESULT_UNCERTAIN';
    try {
      const fresh = await withReadDeadline(async signal => {
        if (client.listCatalogManagerSnapshot)
          return client.listCatalogManagerSnapshot(teamId, { signal });
        if (client.listTeamProductCatalogSnapshot)
          return client.listTeamProductCatalogSnapshot(teamId, { signal });
        return {
          rows: await client.listTeamProductCatalogs(teamId, { signal }),
          invalidRowCount: 0
        };
      }, controller.signal);
      if (!owner.current()) {
        flow.cancel();
        return;
      }
      const current = fresh?.rows.find(item => item.catalogId === row.catalogId);
      const observedRound = Date.parse(row.activeRoundAt ?? '');
      const currentRound = Date.parse(current?.activeRoundAt ?? '');
      if (
        current &&
        (Number.isFinite(observedRound) || row.activeRoundAt === null) &&
        (current.activeRoundAt === null ||
          (Number.isFinite(currentRound) && currentRound !== observedRound))
      ) {
        inactive = true;
        flow.stage('stop_target_inactive');
      } else if (
        Number.isFinite(observedRound) &&
        Number.isFinite(currentRound) &&
        currentRound === observedRound
      ) {
        flow.stage('stop_target_active');
      } else flow.stage('stop_readback_unknown');
    } catch (cause) {
      if (!owner.current()) {
        flow.cancel();
        return;
      }
      readCode = teamErrorCodeOf(cause) ?? 'READ_FAILED';
      flow.stage('stop_readback_unknown', readCode);
    }
    if (inactive) {
      // Our own accepted stop ended the round: that is a success, not a stale target.
      showStopFeedback(
        flow,
        accepted
          ? { tone: 'success', text: t('catalogStopDone') }
          : { tone: 'info', text: t('catalogStopObservedInactive') }
      );
      return;
    }
    showStopFeedback(
      flow,
      {
        tone: 'warning',
        text: t('catalogStopUnconfirmed'),
        action: { label: t('catalogCommandCheck'), run: () => checkStop(row, requestFlowId) }
      },
      readCode
    );
  };
  const stopFailure = (flow: CatalogUiFlow, cause: unknown) => {
    const code = teamErrorCodeOf(cause) ?? 'UNKNOWN';
    flow.stage('stop_rejected', code);
    showStopFeedback(flow, { tone: 'error', text: teamErrorMessageFor(cause, t) }, code);
  };
  const checkStop = (row: CatalogRegistryRow, requestFlowId: string) => {
    if (!owner.current() || busyRef.current.has(row.catalogId)) return;
    const flow = beginCatalogUiFlow('stop', {
      count: 1,
      relatedFlowId: row.activeAttemptId ?? undefined,
      originFlowId: requestFlowId
    });
    stopFlows.current.add(flow);
    flow.stage('stop_check_requested');
    return withBusy(
      [row.catalogId],
      async () => {
        const controller = new AbortController();
        stopControllers.current.add(controller);
        try {
          await observeStop(row, flow, controller, requestFlowId);
        } finally {
          stopControllers.current.delete(controller);
        }
      },
      { onFailure: cause => stopFailure(flow, cause) }
    );
  };
  const cancelNow = (row: CatalogRegistryRow) => {
    if (!owner.current() || busyRef.current.has(row.catalogId) || blocked(row.catalogId)) return;
    const flow = beginCatalogUiFlow('stop', {
      count: 1,
      relatedFlowId: row.activeAttemptId ?? undefined
    });
    stopFlows.current.add(flow);
    flow.stage('stop_requested');
    return withBusy(
      [row.catalogId],
      async () => {
        if (blocked(row.catalogId)) throw new TeamApiError('WRONG_STATE', false);
        if (row.activeRoundAt === undefined)
          throw new TeamApiError('CATALOG_STOP_TARGET_UNKNOWN', false);
        const controller = new AbortController();
        stopControllers.current.add(controller);
        let accepted = false;
        try {
          try {
            const cancelled =
              row.activeRoundAt === null
                ? false
                : await withCatalogCommandDeadline(signal => {
                    if (!client.cancelCatalogUpdate)
                      throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
                    return client.cancelCatalogUpdate(
                      teamId,
                      row.catalogId,
                      { roundAt: row.activeRoundAt!, attemptId: row.activeAttemptId ?? null },
                      owner.options(signal)
                    );
                  }, controller.signal);
            if (!owner.current()) {
              flow.cancel();
              return;
            }
            accepted = cancelled === true;
            flow.stage(cancelled ? 'stop_accepted' : 'stop_not_active');
          } catch (cause) {
            if (!owner.current()) {
              flow.cancel();
              return;
            }
            const code = teamErrorCodeOf(cause);
            if (
              !(cause instanceof TypeError) &&
              code !== 'TEAM_TRANSPORT_UNAVAILABLE' &&
              code !== 'PROCESS_RESULT_UNCERTAIN'
            )
              throw cause;
            flow.stage('stop_reply_unknown', code ?? 'UNKNOWN');
          }
          await observeStop(row, flow, controller, flow.id, accepted);
        } finally {
          stopControllers.current.delete(controller);
        }
      },
      { refreshOnFailure: true, onFailure: cause => stopFailure(flow, cause) }
    );
  };

  return { cancelNow, checkStop };
}
