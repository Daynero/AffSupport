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
import { launchApi } from '../../api/team';
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
  const activeReceipt = useRef<{ launchId: string; generationId: string } | null>(null);
  const lastObserved = useRef<LaunchDetail | null>(null);
  savedHandler.current = onDraftSaved;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      execution.current++;
      executionController.current?.abort();
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
      !mounted.current ||
      !parsed.ok ||
      parsed.value.method !== 'catalog' ||
      !parsed.value.catalog.restitchEnabled ||
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
      if (!(error instanceof TeamApiError && error.code === 'LAUNCH_BUSY')) throw error;
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
    if (cancelRequestIntent.current?.key !== pending.key)
      cancelRequestIntent.current = { key: pending.key, cancelKey: crypto.randomUUID() };
    cancelSubmitting.current = true;
    if (mounted.current) setBusy(true);
    try {
      await launchReply(
        launchApi.cancelRequest(
          teamId,
          pending.id,
          pending.key,
          cancelRequestIntent.current.cancelKey
        )
      );
      const latest = await launchReply(launchApi.detail(teamId, pending.id));
      if (
        mounted.current &&
        latest.generation?.restitchOperationId &&
        ['cancel_requested', 'canceled_with_cleanup_pending', 'canceled'].includes(
          latest.generation.state
        )
      )
        await launchReply(cancelTeamAgentProcess(latest.generation.restitchOperationId)).catch(
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
          error instanceof TeamApiError ? error.code : undefined
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
  const request = useRef<{ id: string; version: string; key: string } | null>(null);
  const generate = async (
    detail: LaunchDetail | null,
    config: LaunchDraft,
    sources: LaunchSourceSnapshot | null,
    expectedVersion: string | null
  ) => {
    if (submitting.current) return;
    const attempt = ++execution.current;
    const controller = new AbortController();
    executionController.current = controller;
    const active = <T>(work: Promise<T>) => whileLaunchActive(work, controller.signal);
    activeReceipt.current = null;
    if (!request.current && !saveIntent.current) cancelRequested.current = false;
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
          config,
          sources
        };
      if (!request.current) {
        if (!saveIntent.current) throw new TeamApiError('INVALID_RESPONSE', false);
        const intended = saveIntent.current;
        const saved = await active(launchReply(launchApi.save(intended)));
        if (attempt !== execution.current) return;
        savedDraft.current = { ...saved, baseVersion: intended.version };
        request.current = { id: saved.id, version: saved.version, key: flowId };
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
      setPendingStage('preparing');
      launchLocalStage({ flowId, launchId: pending.id }, 'preparing');
      await active(
        launchReply(launchApi.generate(teamId, pending.id, pending.version, pending.key))
      );
      if (attempt !== execution.current) return;
      acceptanceConfirmed = true;
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
          error instanceof TeamApiError ? error.code : undefined
        );
      // A proved rejection before acceptance allows correction; an uncertain network outcome retains the same keys and payload.
      if (
        !acceptanceConfirmed &&
        error instanceof TeamApiError &&
        !error.retryable &&
        [
          'INVALID_INPUT',
          'RESTITCH_INVALID',
          'SOURCE_CHANGED',
          'LAUNCH_VERSION_CONFLICT',
          'NO_WORK',
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
  const resume = async (detail: LaunchDetail) => {
    const gen = detail.generation;
    if (!gen?.requestKey || !gen.inputVersion || submitting.current) return;
    const attempt = ++execution.current;
    const controller = new AbortController();
    executionController.current = controller;
    const active = <T>(work: Promise<T>) => whileLaunchActive(work, controller.signal);
    activeReceipt.current = null;
    submitting.current = true;
    setBusy(true);
    setPendingStage('preparing');
    try {
      const parsed = parseLaunchConfig(detail.draft);
      if (
        gen.state === 'failed' &&
        gen.stage === 'restitch_processing' &&
        parsed.ok &&
        parsed.value.method === 'catalog' &&
        parsed.value.catalog.restitchEnabled
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
          error instanceof TeamApiError ? error.code : undefined
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
    try {
      await launchReply(
        launchApi.cancel(teamId, detail.id, generationId, cancelIntent.current.key)
      );
      const latest = await launchReply(launchApi.detail(teamId, detail.id));
      if (
        mounted.current &&
        latest.generation?.id === generationId &&
        ['cancel_requested', 'canceled_with_cleanup_pending', 'canceled'].includes(
          latest.generation.state
        ) &&
        latest.generation.restitchOperationId
      )
        await launchReply(cancelTeamAgentProcess(latest.generation.restitchOperationId)).catch(
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
      if (mounted.current)
        launchAction(
          { launchId: detail.id, generationId },
          'cancel',
          'failure',
          error instanceof TeamApiError ? error.code : undefined
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
