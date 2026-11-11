import { CATALOG_DEFERRED_PUBLICATION_AVAILABLE } from '../product-catalog/CatalogPublicationSchedule';
import { isCatalogForegroundPreparationFailure } from '../../api/catalog-video-foreground';
import { teamErrorCodeOf } from '../errors';
import { catalogForeground } from '../../api/catalog-video-foreground-client';
import type { CatalogForegroundExecutor } from '../../api/catalog-video-foreground';
import { recoveryInstallation } from '../../api/recovery-installation';
import { privateCacheActor, privateCacheActorEpoch } from '../private-cache-scope';
import { launchReply, whileLaunchActive } from './reply';
import { launchIntent, launchAction, launchLocalStage } from './analytics';
import { useEffect, useRef, useState } from 'react';
import { parseLaunchConfig } from '@video-compressor/shared';
import { runLaunchRestitch } from './restitch-runner';
import { cancelTeamAgentProcess } from '../../api/client';
import type {
  LaunchDetail,
  LaunchDraft,
  LaunchSourceSnapshot,
  LaunchStage
} from '@video-compressor/shared';
import { launchApi, teamApi } from '../../api/team';
import { TeamApiError } from '../../api/team';
type SaveIntent = {
  teamId: string;
  id: string | null;
  version: string | null;
  requestKey: string;
  config: LaunchDraft;
  sources: LaunchSourceSnapshot | null;
};
function older(next: unknown, known: unknown) {
  return (
    typeof next === 'string' &&
    typeof known === 'string' &&
    /^\d+$/u.test(next) &&
    /^\d+$/u.test(known) &&
    BigInt(next) < BigInt(known)
  );
}
export function useLaunchGeneration(
  teamId: string,
  onResult: (detail: LaunchDetail) => void,
  onDraftSaved?: (receipt: {
    id: string;
    version: string;
    config: LaunchDraft;
    sources: LaunchSourceSnapshot | null;
  }) => void
) {
  const [busy, setBusy] = useState(false);
  const [pendingStage, setPendingStage] = useState<LaunchStage | null>(null);
  const [, refreshIntentState] = useState(0);
  const mounted = useRef(true);
  const resultHandler = useRef(onResult);
  resultHandler.current = onResult;
  const savedHandler = useRef(onDraftSaved);
  const execution = useRef(0);
  const executionController = useRef<AbortController | null>(null);
  // Once the server accepted a Launch, its browser-side restitch coordinator must
  // finish even if the person closes the detail modal.
  const acceptedWork = useRef(false);
  const activeReceipt = useRef<{ launchId: string; generationId: string } | null>(null);
  const lastObserved = useRef<LaunchDetail | null>(null);
  savedHandler.current = onDraftSaved;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!acceptedWork.current) {
        execution.current++;
        executionController.current?.abort();
      }
    };
  }, []);
  const notify = (detail: LaunchDetail) => {
    const known = lastObserved.current;
    if (
      known?.id === detail.id &&
      (older(detail.version, known.version) ||
        (known.generation?.id === detail.generation?.id &&
          older(detail.generation?.stateVersion, known.generation?.stateVersion)))
    )
      return;
    lastObserved.current = detail;
    if (mounted.current) resultHandler.current(detail);
  };
  const continueAccepted = async (detail: LaunchDetail, attempt: number, signal: AbortSignal) => {
    if (attempt !== execution.current) return;
    if (detail.generation)
      activeReceipt.current = { launchId: detail.id, generationId: detail.generation.id };
    if (mounted.current) setPendingStage(null);
    const parsed = parseLaunchConfig(detail.draft);
    notify(detail);
    if (
      !parsed.ok ||
      parsed.value.method !== 'catalog' ||
      !parsed.value.catalog.restitchEnabled ||
      parsed.value.catalog.catalogVideoProtocolVersion === 1 ||
      !detail.generation ||
      !['accepted', 'waiting_dependency'].includes(detail.generation.state)
    )
      return;
    try {
      await whileLaunchActive(
        runLaunchRestitch({
          signal,
          teamId,
          generationId: detail.generation.id,
          video: { id: parsed.value.materialId, name: parsed.value.creativeAlias }
        }),
        signal
      );
    } catch (error) {
      // An existing child still running is progress, not permission to start another.
      if (!(error instanceof TeamApiError && error.code === 'LAUNCH_BUSY')) {
        if (attempt !== execution.current || signal.aborted) throw error;
        // Settlement can have recorded a failed child before Realtime arrives.
        // Expose that durable state so Repeat chooses retry, not another replay.
        try {
          const latest = await whileLaunchActive(
            launchReply(launchApi.detail(teamId, detail.id)),
            signal
          );
          if (
            attempt === execution.current &&
            latest.id === detail.id &&
            latest.generation?.id === detail.generation?.id
          )
            notify(latest);
        } catch {
          // Keep the original failure and the same recovery keys if readback fails.
        }
        throw error;
      }
    }
    if (attempt !== execution.current) return;
    const latest = await whileLaunchActive(
      launchReply(launchApi.detail(teamId, detail.id)),
      signal
    );
    if (attempt === execution.current) notify(latest);
  };
  const submitting = useRef(false);
  const flow = useRef<string | null>(null);
  const cancelSubmitting = useRef(false);
  const cancelRequested = useRef(false);
  const releaseSubmission = () => {
    execution.current++;
    executionController.current?.abort();
    acceptedWork.current = false;
    submitting.current = false;
    activeReceipt.current = null;
    if (mounted.current) {
      setPendingStage(null);
      setBusy(cancelSubmitting.current);
    }
  };
  const cancelRequestIntent = useRef<{ key: string; cancelKey: string } | null>(null);
  const cancelPending = async () => {
    cancelRequested.current = true;
    if (mounted.current) setPendingStage('cancel');
    const pending = request.current;
    // The save may have committed with its reply still in flight. Its existing
    // idempotent receipt must be reconciled before cancellation can be fenced.
    if (!pending || cancelSubmitting.current) return;
    requireRequestOwner();
    if (cancelRequestIntent.current?.key !== pending.key)
      cancelRequestIntent.current = { key: pending.key, cancelKey: crypto.randomUUID() };
    cancelSubmitting.current = true;
    if (mounted.current) setBusy(true);
    try {
      const receipt = await launchReply(
        launchApi.cancelRequest(
          teamId,
          pending.id,
          pending.key,
          cancelRequestIntent.current.cancelKey
        )
      );
      requireRequestOwner();
      const latest = receipt?.detail ?? (await launchReply(launchApi.detail(teamId, pending.id)));
      requireRequestOwner();
      const canceledGenerationId =
        typeof receipt?.id === 'string' ? receipt.id : activeReceipt.current?.generationId;
      if (
        mounted.current &&
        canceledGenerationId &&
        latest.generation?.id === canceledGenerationId &&
        latest.generation?.restitchOperationId &&
        ['cancel_requested', 'canceled_with_cleanup_pending', 'canceled'].includes(
          latest.generation.state
        )
      )
        void launchReply(cancelTeamAgentProcess(latest.generation.restitchOperationId)).catch(
          () => false
        );
      notify(latest);
      releaseSubmission();
      request.current = null;
      saveIntent.current = null;
      flow.current = null;
      cancelRequestIntent.current = null;
      if (mounted.current)
        launchAction({ flowId: pending.key, launchId: pending.id }, 'cancel', 'success');
    } catch (error) {
      if (mounted.current)
        launchAction(
          { flowId: pending.key, launchId: pending.id },
          'cancel',
          'failure',
          teamErrorCodeOf(error) ?? undefined
        );
      throw error;
    } finally {
      cancelSubmitting.current = false;
      if (mounted.current) {
        refreshIntentState(value => value + 1);
        setBusy(submitting.current);
      }
    }
  };
  const cancelIntent = useRef<{ generationId: string; key: string } | null>(null);
  const retryIntent = useRef<{
    generationId: string;
    key: string;
    kind: 'restitch' | 'generation';
  } | null>(null);
  const intent = (method: 'catalog' | 'other', launchId?: string) => {
    if (!flow.current) {
      flow.current = crypto.randomUUID();
      launchIntent({ flowId: flow.current, launchId }, method);
    }
    return flow.current;
  };
  const blocked = (code: string) => {
    launchAction({ flowId: flow.current ?? undefined }, 'generate', 'blocked', code);
    flow.current = null;
  };
  const saveIntent = useRef<SaveIntent | null>(null);
  // A known pre-acceptance rejection must not lose an already saved draft's identity.
  const savedDraft = useRef<{ id: string; version: string; baseVersion: string | null } | null>(
    null
  );
  const requestOwner = useRef<{ teamId: string; actor: string | null; epoch: number } | null>(null);
  const request = useRef<{
    id: string;
    version: string;
    key: string;
    expectedExecutorId?: string;
    foregroundExecutor?: CatalogForegroundExecutor;
    foregroundPrepared?: boolean;
    admissionDispatched?: boolean;
    foregroundRequired?: boolean;
    sourceMaterialId?: string;
  } | null>(null);
  const requireRequestOwner = () => {
    const owner = requestOwner.current;
    if (
      owner &&
      (owner.teamId !== teamId ||
        owner.actor !== privateCacheActor() ||
        owner.epoch !== privateCacheActorEpoch())
    )
      throw new TeamApiError('PERMISSION_DENIED', false);
  };
  const generate = async (
    detail: LaunchDetail | null,
    config: LaunchDraft,
    sources: LaunchSourceSnapshot | null,
    expectedVersion: string | null
  ) => {
    if (submitting.current) return;
    if (request.current || saveIntent.current) requireRequestOwner();
    const attempt = ++execution.current;
    const controller = new AbortController();
    executionController.current = controller;
    const active = <T>(work: Promise<T>) => whileLaunchActive(work, controller.signal);
    activeReceipt.current = null;
    if (!request.current && !saveIntent.current) {
      cancelRequested.current = false;
      requestOwner.current = {
        teamId,
        actor: privateCacheActor(),
        epoch: privateCacheActorEpoch()
      };
    }
    const flowId = intent(config.method ?? 'other', detail?.id);
    submitting.current = true;
    setBusy(true);
    setPendingStage(cancelRequested.current ? 'cancel' : 'validation');
    let acceptanceConfirmed = false;
    try {
      if (!saveIntent.current && !request.current)
        saveIntent.current = {
          teamId,
          id: detail?.id ?? savedDraft.current?.id ?? null,
          version:
            savedDraft.current?.id === detail?.id &&
            savedDraft.current?.baseVersion === expectedVersion
              ? savedDraft.current.version
              : (expectedVersion ?? savedDraft.current?.version ?? null),
          requestKey: crypto.randomUUID(),
          config:
            config.method === 'catalog' && config.catalog
              ? {
                  ...config,
                  catalog: {
                    ...config.catalog,
                    catalogVideoProtocolVersion: 1,
                    videoVariationCount: config.catalog.videoVariationCount ?? 1,
                    videoPublication: CATALOG_DEFERRED_PUBLICATION_AVAILABLE
                      ? (config.catalog.videoPublication ?? { mode: 'immediate' })
                      : { mode: 'immediate' }
                  }
                }
              : config,
          sources
        };
      if (!request.current) {
        if (!saveIntent.current) throw new TeamApiError('INVALID_RESPONSE', false);
        const intended = saveIntent.current;
        const saved = await active(launchReply(launchApi.save(intended)));
        if (attempt !== execution.current) return;
        requireRequestOwner();
        savedDraft.current = { ...saved, baseVersion: intended.version };
        request.current = {
          id: saved.id,
          version: saved.version,
          key: flowId,
          sourceMaterialId: intended.config.materialId,
          foregroundRequired:
            intended.config.catalog?.catalogVideoProtocolVersion === 1 &&
            intended.config.catalog.restitchEnabled,
          ...(intended.config.catalog?.catalogVideoProtocolVersion === 1 &&
          intended.config.catalog.restitchEnabled
            ? { expectedExecutorId: recoveryInstallation() ?? undefined }
            : {})
        };
        saveIntent.current = null;
        if (!mounted.current) return;
        savedHandler.current?.({ ...saved, config: intended.config, sources: intended.sources });
        launchLocalStage({ flowId, launchId: saved.id }, 'draft_saved');
        setPendingStage('draft_saved');
      }
      const pending = request.current;
      if (cancelRequested.current) {
        await cancelPending();
        return;
      }
      const dispatch = async (foregroundExecutor: CatalogForegroundExecutor | undefined) => {
        requireRequestOwner();
        if (cancelRequested.current) {
          await cancelPending();
          throw new TeamApiError('PROCESS_CANCELED', false);
        }
        pending.foregroundExecutor = foregroundExecutor;
        pending.foregroundPrepared = true;
        setPendingStage('preparing');
        launchLocalStage({ flowId, launchId: pending.id }, 'preparing');
        pending.admissionDispatched = true;
        return launchReply(
          pending.expectedExecutorId || foregroundExecutor
            ? launchApi.generate(
                teamId,
                pending.id,
                pending.version,
                pending.key,
                foregroundExecutor ? undefined : pending.expectedExecutorId,
                foregroundExecutor
              )
            : launchApi.generate(teamId, pending.id, pending.version, pending.key)
        );
      };
      await active(
        pending.foregroundRequired && !pending.foregroundPrepared
          ? catalogForeground.admit(
              {
                kind: 'launch',
                teamId,
                launchId: pending.id,
                sourceMaterialId: pending.sourceMaterialId!,
                requestKey: pending.key,
                expectedVersion: pending.version
              },
              dispatch,
              controller.signal,
              pending.foregroundExecutor
            )
          : dispatch(pending.foregroundExecutor)
      );
      if (attempt !== execution.current) return;
      requireRequestOwner();
      acceptanceConfirmed = true;
      acceptedWork.current = true;
      if (mounted.current) setPendingStage('accepted');
      if (cancelRequested.current || request.current !== pending) {
        if (request.current === pending) await cancelPending();
        return;
      }
      await continueAccepted(
        await active(launchReply(launchApi.detail(teamId, pending.id))),
        attempt,
        controller.signal
      );
      if (attempt !== execution.current) return;
      request.current = null;
      flow.current = null;
    } catch (error) {
      if (attempt !== execution.current) return;
      if (cancelRequested.current && request.current === null && saveIntent.current === null)
        return;
      if (
        cancelRequested.current &&
        error instanceof TeamApiError &&
        error.code === 'PROCESS_CANCELED'
      ) {
        await cancelPending();
        return;
      }
      if (mounted.current)
        launchAction(
          { flowId, launchId: request.current?.id ?? detail?.id },
          'generate',
          'failure',
          teamErrorCodeOf(error) ?? undefined
        );
      const owner = requestOwner.current;
      // The wrapper brands a local failure only after a proved server refusal.
      // Unknown admission replies retain the original intent and keys.
      if (
        isCatalogForegroundPreparationFailure(error) &&
        request.current &&
        !cancelRequested.current &&
        owner?.teamId === teamId &&
        owner.actor === privateCacheActor() &&
        owner.epoch === privateCacheActorEpoch()
      ) {
        request.current = null;
        saveIntent.current = null;
        flow.current = null;
      }
      // A proved rejection before acceptance allows correction; an uncertain network outcome retains the same keys and payload.
      if (
        !acceptanceConfirmed &&
        owner?.teamId === teamId &&
        owner.actor === privateCacheActor() &&
        owner.epoch === privateCacheActorEpoch() &&
        error instanceof TeamApiError &&
        !error.retryable &&
        [
          'INVALID_INPUT',
          'RESTITCH_INVALID',
          'RESTITCH_SOURCES_INVALID',
          'SOURCE_CHANGED',
          'LAUNCH_VERSION_CONFLICT',
          'NO_WORK',
          'AGENT_REQUIRED',
          'WRONG_STATE'
        ].includes(error.code)
      ) {
        saveIntent.current = null;
        request.current = null;
        flow.current = null;
      }
      throw error;
    } finally {
      if (attempt === execution.current) submitting.current = false;
      if (mounted.current && attempt === execution.current) {
        refreshIntentState(value => value + 1);
        setBusy(cancelSubmitting.current);
        if (!request.current && !saveIntent.current) setPendingStage(null);
      }
    }
  };
  const resume = async (detail: LaunchDetail, failedRestitchOperationId?: string) => {
    let gen = detail.generation;
    if (!gen?.requestKey || !gen.inputVersion || submitting.current) return;
    if (['cancel_requested', 'canceled_with_cleanup_pending'].includes(gen.state))
      throw new TeamApiError('LAUNCH_BUSY', true);
    if (['succeeded', 'canceled'].includes(gen.state)) return;
    const attempt = ++execution.current;
    const controller = new AbortController();
    executionController.current = controller;
    const active = <T>(work: Promise<T>) => whileLaunchActive(work, controller.signal);
    activeReceipt.current = null;
    submitting.current = true;
    setBusy(true);
    setPendingStage('preparing');
    try {
      // A failed native child can precede its parent's Realtime update. Settle
      // the durable receipt before choosing replay versus an explicit retry.
      if (gen.state === 'waiting_dependency') {
        // An explicit Repeat can retire a child proved terminal by this paired
        // agent even when an older server left its durable row running.
        if (failedRestitchOperationId && gen.restitchOperationId === failedRestitchOperationId)
          await active(launchReply(teamApi.cancelOperation(teamId, failedRestitchOperationId)));

        await active(launchReply(launchApi.settleRestitch(teamId, gen.id)));
        const latest = await active(launchReply(launchApi.detail(teamId, detail.id)));
        if (attempt !== execution.current) return;
        if (latest.generation?.id !== gen.id || latest.generation.requestKey !== gen.requestKey)
          throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
        detail = latest;
        gen = latest.generation;
        if (
          ['succeeded', 'canceled', 'cancel_requested', 'canceled_with_cleanup_pending'].includes(
            gen.state
          )
        ) {
          notify(latest);
          return;
        }
      }
      if (!gen.requestKey || !gen.inputVersion) throw new TeamApiError('INVALID_RESPONSE', false);
      const parsed = parseLaunchConfig(detail.draft);
      if (
        gen.state === 'failed' &&
        gen.stage === 'restitch_processing' &&
        parsed.ok &&
        parsed.value.method === 'catalog' &&
        parsed.value.catalog.restitchEnabled &&
        parsed.value.catalog.catalogVideoProtocolVersion !== 1
      ) {
        if (retryIntent.current?.generationId !== gen.id || retryIntent.current.kind !== 'restitch')
          retryIntent.current = {
            generationId: gen.id,
            key: crypto.randomUUID(),
            kind: 'restitch'
          };
        await active(launchReply(launchApi.retryRestitch(teamId, gen.id, retryIntent.current.key)));
        if (attempt !== execution.current) return;
        retryIntent.current = null;
      } else {
        if (['failed', 'partial', 'interrupted'].includes(gen.state)) {
          if (
            retryIntent.current?.generationId !== gen.id ||
            retryIntent.current.kind !== 'generation'
          )
            retryIntent.current = {
              generationId: gen.id,
              key: crypto.randomUUID(),
              kind: 'generation'
            };
          await active(
            launchReply(launchApi.retryGeneration(teamId, gen.id, retryIntent.current.key))
          );
          if (attempt !== execution.current) return;
          retryIntent.current = null;
        }
        await active(
          launchReply(launchApi.generate(teamId, detail.id, gen.inputVersion, gen.requestKey))
        );
      }
      if (attempt !== execution.current) return;
      acceptedWork.current = true;
      if (mounted.current)
        launchAction({ launchId: detail.id, generationId: gen.id }, 'retry', 'success');
      await continueAccepted(
        await active(launchReply(launchApi.detail(teamId, detail.id))),
        attempt,
        controller.signal
      );
    } catch (error) {
      if (attempt !== execution.current) return;
      if (mounted.current)
        launchAction(
          { launchId: detail.id, generationId: gen.id },
          'retry',
          'failure',
          teamErrorCodeOf(error) ?? undefined
        );
      throw error;
    } finally {
      if (attempt === execution.current) submitting.current = false;
      if (mounted.current && attempt === execution.current) {
        setPendingStage(null);
        refreshIntentState(value => value + 1);
        setBusy(cancelSubmitting.current);
      }
    }
  };
  const cancel = async (detail: LaunchDetail) => {
    if (!detail.generation || cancelSubmitting.current) return;
    const generationId = detail.generation.id;
    if (cancelIntent.current?.generationId !== generationId)
      cancelIntent.current = { generationId, key: crypto.randomUUID() };
    cancelSubmitting.current = true;
    setBusy(true);
    setPendingStage('cancel');
    let ownsVideoReply: (() => boolean) | undefined;
    try {
      if (detail.generation.state === 'succeeded' && detail.generation.videoGeneration) {
        const actor = privateCacheActor(),
          epoch = privateCacheActorEpoch();
        const ownsReply = () =>
          mounted.current && privateCacheActor() === actor && privateCacheActorEpoch() === epoch;
        ownsVideoReply = ownsReply;
        const receipt = await launchReply(
          launchApi.cancelCatalogVideoGeneration(teamId, generationId, cancelIntent.current.key)
        );
        if (!ownsReply()) return;
        const operationId = detail.generation.videoGeneration.activeChildOperationId;
        if (operationId && ['cancel_requested', 'canceled'].includes(receipt.state))
          void launchReply(cancelTeamAgentProcess(operationId)).catch(() => false);
        const latest = await launchReply(launchApi.detail(teamId, detail.id));
        if (!ownsReply()) return;
        notify(latest);
        cancelIntent.current = null;
        if (mounted.current)
          launchAction({ launchId: detail.id, generationId }, 'cancel', 'success');
        return;
      }
      const receipt = await launchReply(
        launchApi.cancel(teamId, detail.id, generationId, cancelIntent.current.key)
      );
      // Stop native work as soon as the server accepts cancellation. Neither
      // a slow detail read nor an unreachable agent may hold the UI hostage.
      const cancelAccepted =
        receipt &&
        typeof receipt === 'object' &&
        'state' in receipt &&
        ['cancel_requested', 'canceled_with_cleanup_pending', 'canceled'].includes(
          String(receipt.state)
        );
      if (cancelAccepted && detail.generation?.restitchOperationId)
        void launchReply(cancelTeamAgentProcess(detail.generation.restitchOperationId)).catch(
          () => false
        );
      const latest = receipt?.detail ?? (await launchReply(launchApi.detail(teamId, detail.id)));
      if (
        !cancelAccepted &&
        mounted.current &&
        latest.generation?.id === generationId &&
        ['cancel_requested', 'canceled_with_cleanup_pending', 'canceled'].includes(
          latest.generation.state
        ) &&
        latest.generation.restitchOperationId
      )
        void launchReply(cancelTeamAgentProcess(latest.generation.restitchOperationId)).catch(
          () => false
        );
      notify(latest);
      releaseSubmission();
      request.current = null;
      saveIntent.current = null;
      flow.current = null;
      cancelIntent.current = null;
      if (mounted.current) launchAction({ launchId: detail.id, generationId }, 'cancel', 'success');
    } catch (error) {
      if (ownsVideoReply && !ownsVideoReply()) return;
      if (mounted.current)
        launchAction(
          { launchId: detail.id, generationId },
          'cancel',
          'failure',
          teamErrorCodeOf(error) ?? undefined
        );
      throw error;
    } finally {
      cancelSubmitting.current = false;
      if (mounted.current) {
        setPendingStage(null);
        refreshIntentState(value => value + 1);
        setBusy(submitting.current);
      }
    }
  };
  const retry = async (
    detail: LaunchDetail | null,
    config: LaunchDraft,
    sources: LaunchSourceSnapshot | null,
    expectedVersion: string | null
  ) => {
    if (submitting.current || cancelSubmitting.current) return;
    requireRequestOwner();
    const pending = request.current;
    if (pending && !cancelRequested.current) {
      const reconciliation = ++execution.current;
      submitting.current = true;
      setBusy(true);
      let latest: LaunchDetail;
      try {
        latest = await launchReply(launchApi.detail(teamId, pending.id));
      } catch (error) {
        if (reconciliation !== execution.current) return;
        if (mounted.current)
          launchAction(
            { flowId: pending.key, launchId: pending.id },
            'retry',
            'failure',
            teamErrorCodeOf(error) ?? undefined
          );
        throw error;
      } finally {
        if (reconciliation === execution.current) {
          submitting.current = false;
          if (mounted.current) setBusy(cancelSubmitting.current);
        }
      }
      if (!mounted.current || reconciliation !== execution.current || request.current !== pending)
        return;
      if (
        !cancelRequested.current &&
        latest.generation?.requestKey === pending.key &&
        ['failed', 'partial', 'interrupted'].includes(latest.generation.state)
      ) {
        request.current = null;
        saveIntent.current = null;
        flow.current = null;
        return resume(latest);
      }
    }
    return generate(detail, config, sources, expectedVersion);
  };
  return {
    busy,
    pendingStage,
    observe: (detail: LaunchDetail) => {
      const known = lastObserved.current;
      if (
        known?.id === detail.id &&
        (older(detail.version, known.version) ||
          (known.generation?.id === detail.generation?.id &&
            older(detail.generation?.stateVersion, known.generation?.stateVersion)))
      )
        return false;
      const owner = requestOwner.current;
      if (
        cancelRequested.current &&
        (!owner ||
          owner.teamId !== teamId ||
          owner.actor !== privateCacheActor() ||
          owner.epoch !== privateCacheActorEpoch())
      )
        return false;
      lastObserved.current = detail;
      const terminal =
        detail.generation &&
        !['accepted', 'running', 'waiting_dependency'].includes(detail.generation.state);
      const pendingMatches = Boolean(
        request.current &&
        detail.generation &&
        detail.id === request.current.id &&
        detail.generation.requestKey === request.current.key
      );
      const activeMatches =
        activeReceipt.current?.launchId === detail.id &&
        activeReceipt.current?.generationId === detail.generation?.id;
      const released = Boolean(terminal && submitting.current && (activeMatches || pendingMatches));
      if (released) releaseSubmission();
      // An exact terminal receipt resolves a lost cancel reply. Success can win
      // the race; observing it must not dispatch cancellation or another run.
      if (
        cancelRequested.current &&
        pendingMatches &&
        ['canceled', 'succeeded'].includes(detail.generation!.state)
      ) {
        if (!released) releaseSubmission();
        request.current = null;
        saveIntent.current = null;
        flow.current = null;
        cancelRequestIntent.current = null;
        cancelRequested.current = false;
        if (mounted.current) refreshIntentState(value => value + 1);
        return true;
      }
      if (
        !request.current ||
        cancelRequested.current ||
        !detail.generation ||
        detail.id !== request.current.id ||
        detail.generation.requestKey !== request.current.key
      )
        return released;
      // Realtime acceptance can precede the POST reply. Do not invalidate the
      // request before that very submission has entered its accepted workflow.
      if (submitting.current && !terminal && !activeMatches) {
        if (mounted.current) setPendingStage(null);
        return false;
      }
      request.current = null;
      saveIntent.current = null;
      flow.current = null;
      if (mounted.current) {
        setPendingStage(null);
        refreshIntentState(value => value + 1);
      }
      return true;
    },
    generate,
    retry,
    resume,
    cancel,
    cancelPending,
    intent,
    blocked,
    abandon: () => {
      if (submitting.current || request.current || saveIntent.current) return;
      if (flow.current && mounted.current)
        launchAction({ flowId: flow.current }, 'generate', 'cancelled');
      flow.current = null;
    },
    hasUnresolvedRequest: request.current !== null || saveIntent.current !== null
  };
}
