import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  transcriptSidecarName,
  translationSidecarName,
  type LibraryJobKind,
  type ToolContracts
} from '@video-compressor/shared';
import {
  teamApi,
  TeamApiError,
  type LibraryJobClaimEnvelope,
  type LibraryProcessingContext,
  type LibraryRequirementScanResult
} from '../../api/team';
import { cancelTeamLibraryAgentProcess, startTeamLibraryAgentProcess } from '../../api/client';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessage } from '../errors';
import {
  stableLibraryAgentInstanceId,
  type ProcessLibraryAgent,
  type ProcessLibraryClient
} from './process-library-contract';

const HEARTBEAT_MS = 25_000;

/**
 * Where the batch is, from the space's point of view.
 *
 * `scanning` and `ready` precede a run; the rest are the machine in
 * data-model §6. They live here rather than in the dialog because the run has
 * to outlive the window that started it.
 */
export type LibraryProcessingPhase =
  'idle' | 'scanning' | 'ready' | 'running' | 'complete' | 'failed' | 'canceled';

export interface LibraryProcessingValue {
  phase: LibraryProcessingPhase;
  scan: LibraryRequirementScanResult | null;
  /** Job kinds this device can actually run, given the agent's tool contracts. */
  supportedKinds: LibraryJobKind[];
  activeKind: LibraryJobKind | null;
  done: number;
  skipped: number;
  failed: number;
  /** Names of the files whose jobs failed, so a partial result can be specific. */
  failedNames: string[];
  total: number;
  errorCode: string | null;
  rescan: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

const LibraryProcessingContextValue = createContext<LibraryProcessingValue | null>(null);

const defaultAgent: ProcessLibraryAgent = {
  process: startTeamLibraryAgentProcess,
  cancel: cancelTeamLibraryAgentProcess
};

function safeErrorCode(error: unknown): string {
  const raw =
    error instanceof TeamApiError ? error.code : error instanceof Error ? error.message : '';
  return raw.match(/[A-Z][A-Z0-9_]{2,63}/u)?.[0] ?? 'PROCESS_FAILED';
}

function toolForKind(kind: LibraryJobKind): string {
  if (kind === 'landing_optimization') return 'landingOptimizer';
  return kind;
}

function outputName(job: LibraryJobClaimEnvelope, context: LibraryProcessingContext): string {
  if (job.kind === 'transcription') {
    return transcriptSidecarName(context.sourceName, job.sourceVersion);
  }
  if (job.kind === 'translation') {
    return translationSidecarName(context.sourceName, job.sourceVersion, job.variant);
  }
  const stem = context.sourceName.replace(/\.[^.]+$/u, '').slice(0, 180) || 'landing';
  const suffix = job.sourceVersion.replace(/[^a-z0-9]/giu, '').slice(0, 12) || 'current';
  return `${stem}.optimized.${suffix}.zip`;
}

function optionsForJob(job: LibraryJobClaimEnvelope): Record<string, unknown> {
  if (job.kind === 'translation') return { language: 'auto', targetLanguage: job.variant };
  if (job.kind === 'transcription') return { language: 'auto' };
  return {};
}

/**
 * Owns the library batch for an entered space.
 *
 * The claim loop used to live inside `ProcessLibraryDialog`, whose unmount
 * released the active lease — so closing the window cancelled the work, and no
 * progress was visible anywhere else (finding B1, FR-032). Here the run belongs
 * to the space: the dialog becomes a viewer, and only leaving team mode (or
 * closing the tab) releases the lease.
 */
export function LibraryProcessingProvider({
  teamId,
  sourceMaterialId,
  agentCompatible,
  toolContracts,
  client = teamApi,
  agent = defaultAgent,
  agentInstanceId,
  onChanged,
  children
}: {
  teamId: string;
  sourceMaterialId?: string;
  agentCompatible: boolean;
  toolContracts: ToolContracts;
  client?: ProcessLibraryClient;
  agent?: ProcessLibraryAgent;
  agentInstanceId?: string;
  onChanged?: () => void;
  children: ReactNode;
}) {
  const { language, t } = useI18n();
  const { push } = useToasts();
  const instanceId = useMemo(
    () => agentInstanceId ?? stableLibraryAgentInstanceId(),
    [agentInstanceId]
  );

  const [phase, setPhase] = useState<LibraryProcessingPhase>('idle');
  const [scan, setScan] = useState<LibraryRequirementScanResult | null>(null);
  const [activeKind, setActiveKind] = useState<LibraryJobKind | null>(null);
  const [done, setDone] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [failed, setFailed] = useState(0);
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const control = useRef({
    stopped: false,
    attempt: null as LibraryJobClaimEnvelope | null,
    operationId: null as string | null
  });

  const supportedKinds = useMemo<LibraryJobKind[]>(() => {
    if (!agentCompatible || (toolContracts.teamWorkspace ?? 0) < 1) return [];
    const kinds: LibraryJobKind[] = [];
    if ((toolContracts.transcription ?? 0) >= 5) kinds.push('transcription', 'translation');
    if (!sourceMaterialId && (toolContracts.landingOptimizer ?? 0) >= 2) {
      kinds.push('landing_optimization');
    }
    return kinds;
  }, [agentCompatible, sourceMaterialId, toolContracts]);

  const rescan = useCallback(async () => {
    setPhase('scanning');
    setErrorCode(null);
    try {
      setScan(await client.scanLibraryRequirements(teamId, language, sourceMaterialId));
      setPhase('ready');
    } catch (error) {
      setErrorCode(safeErrorCode(error));
      setPhase('failed');
    }
  }, [client, language, sourceMaterialId, teamId]);

  /** Give the server back the lease this device is holding, if any. */
  const releaseActive = useCallback(async () => {
    control.current.stopped = true;
    const attempt = control.current.attempt;
    const operationId = control.current.operationId;
    if (attempt) {
      await Promise.allSettled([
        agent.cancel(attempt.attemptId),
        client.cancelLibraryJob({
          teamId,
          attemptId: attempt.attemptId,
          agentInstanceId: instanceId,
          leaseToken: attempt.leaseToken
        }),
        operationId ? client.cancelOperation(teamId, operationId) : Promise.resolve()
      ]);
    }
    control.current.attempt = null;
    control.current.operationId = null;
    setActiveKind(null);
  }, [agent, client, instanceId, teamId]);

  // Only leaving the space releases the lease — not closing the dialog.
  useEffect(
    () => () => {
      if (control.current.attempt) void releaseActive();
    },
    [releaseActive]
  );

  const total = scan
    ? scan.missing.transcription + scan.missing.translation + scan.missing.landingOptimization
    : 0;

  /**
   * The summary, said once when the batch settles.
   *
   * A partly-failed batch must never read as success (FR-032), so the tone and
   * the wording follow the failure count, and the failed files are named.
   */
  const summarize = useCallback(
    (counts: { done: number; skipped: number; failed: number; names: string[] }) => {
      if (counts.failed > 0) {
        push({
          tone: 'error',
          text: t('creativeLibraryProcessSummaryPartial', {
            done: counts.done,
            failed: counts.failed,
            names: counts.names.slice(0, 3).join(', ')
          })
        });
        return;
      }
      if (counts.done === 0 && counts.skipped === 0) {
        push({ tone: 'info', text: t('creativeLibraryProcessSummaryNothing') });
        return;
      }
      push({
        tone: 'success',
        text: t('creativeLibraryProcessSummaryDone', { done: counts.done })
      });
    },
    [push, t]
  );

  const start = useCallback(async () => {
    if (supportedKinds.length === 0) return;
    control.current.stopped = false;
    setPhase('running');
    setErrorCode(null);
    const counts = { done: 0, skipped: 0, failed: 0, names: [] as string[] };
    for (;;) {
      if (control.current.stopped) return;
      let job: LibraryJobClaimEnvelope;
      try {
        job = await client.claimLibraryJob({
          teamId,
          agentInstanceId: instanceId,
          supportedKinds,
          interfaceLanguage: language,
          ...(sourceMaterialId ? { sourceMaterialId } : {})
        });
      } catch (error) {
        if (safeErrorCode(error) === 'NO_WORK') {
          setActiveKind(null);
          await rescan();
          setPhase('complete');
          summarize(counts);
          onChanged?.();
          return;
        }
        setErrorCode(safeErrorCode(error));
        setPhase('failed');
        summarize(counts);
        return;
      }

      control.current.attempt = job;
      setActiveKind(job.kind);
      let operationId: string | null = null;
      let heartbeat: number | null = null;
      let sourceName = job.sourceMaterialId;
      try {
        const context = await client.getLibraryProcessingContext(teamId, job.sourceMaterialId);
        sourceName = context.sourceName;
        const toolContractVersion =
          job.kind === 'landing_optimization'
            ? (toolContracts.landingOptimizer ?? 0)
            : (toolContracts.transcription ?? 0);
        await client.heartbeatLibraryJob({
          teamId,
          attemptId: job.attemptId,
          agentInstanceId: instanceId,
          leaseToken: job.leaseToken,
          progress: 5,
          stage: 'preparing'
        });
        const started = await client.startProcess({
          teamId,
          materialId: job.sourceMaterialId,
          toolId: toolForKind(job.kind),
          optionsSummary: { requirementId: job.requirementId, variant: job.variant },
          destinationFolderId: context.destinationFolderId,
          outputName: outputName(job, context),
          conflictMode: 'cancel',
          idempotencyKey: `library.process.${job.attemptId}`,
          agentContractVersion: 1,
          toolContractVersion
        });
        operationId = started.operationId;
        control.current.operationId = operationId;
        heartbeat = window.setInterval(() => {
          void client
            .heartbeatLibraryJob({
              teamId,
              attemptId: job.attemptId,
              agentInstanceId: instanceId,
              leaseToken: job.leaseToken,
              progress: 35,
              stage: 'processing'
            })
            .catch(() => undefined);
        }, HEARTBEAT_MS);
        const processed = await agent.process({
          operationId,
          teamId,
          requirementId: job.requirementId,
          attemptId: job.attemptId,
          agentInstanceId: instanceId,
          kind: job.kind,
          variant: job.variant,
          sourceVersion: job.sourceVersion,
          leaseToken: job.leaseToken,
          sourceGrant: started.sourceGrant,
          finalizeGrant: started.finalizeGrant,
          options: optionsForJob(job)
        });
        if (processed.state !== 'succeeded' || !processed.materialId) {
          throw new Error('PROCESS_FAILED');
        }
        const finalized = await client.finalizeLibraryJob({
          teamId,
          attemptId: job.attemptId,
          agentInstanceId: instanceId,
          leaseToken: job.leaseToken,
          resultMaterialId: processed.materialId,
          sourceVersion: job.sourceVersion,
          idempotencyKey: `library.result.${job.attemptId}`
        });
        if (finalized.state === 'accepted') {
          counts.done += 1;
          setDone(value => value + 1);
        } else {
          counts.skipped += 1;
          setSkipped(value => value + 1);
        }
      } catch (error) {
        if (control.current.stopped) return;
        const code = safeErrorCode(error);
        await Promise.allSettled([
          client.failLibraryJob({
            teamId,
            attemptId: job.attemptId,
            agentInstanceId: instanceId,
            leaseToken: job.leaseToken,
            errorCode: code
          }),
          operationId ? client.cancelOperation(teamId, operationId) : Promise.resolve()
        ]);
        counts.failed += 1;
        counts.names.push(sourceName);
        setFailed(value => value + 1);
        setFailedNames(value => [...value, sourceName]);
      } finally {
        if (heartbeat) window.clearInterval(heartbeat);
        control.current.attempt = null;
        control.current.operationId = null;
      }
    }
  }, [
    agent,
    client,
    instanceId,
    language,
    onChanged,
    rescan,
    sourceMaterialId,
    summarize,
    supportedKinds,
    teamId,
    toolContracts.landingOptimizer,
    toolContracts.transcription
  ]);

  /** Stopping on purpose, which is a different outcome from the run failing. */
  const cancel = useCallback(async () => {
    await releaseActive();
    setPhase('canceled');
    push({ tone: 'info', text: t('creativeLibraryProcessCanceled') });
  }, [push, releaseActive, t]);

  const retryFailed = useCallback(async () => {
    try {
      await client.retryFailedLibraryJobs(teamId, sourceMaterialId);
      setFailed(0);
      setFailedNames([]);
      await start();
    } catch (error) {
      const code = safeErrorCode(error);
      setErrorCode(code);
      push({ tone: 'error', text: teamErrorMessage(code, t) });
    }
  }, [client, push, sourceMaterialId, start, t, teamId]);

  const value = useMemo<LibraryProcessingValue>(
    () => ({
      phase,
      scan,
      supportedKinds,
      activeKind,
      done,
      skipped,
      failed,
      failedNames,
      total,
      errorCode,
      rescan,
      start,
      cancel,
      retryFailed
    }),
    [
      activeKind,
      cancel,
      done,
      errorCode,
      failed,
      failedNames,
      phase,
      rescan,
      retryFailed,
      scan,
      skipped,
      start,
      supportedKinds,
      total
    ]
  );

  return (
    <LibraryProcessingContextValue.Provider value={value}>
      {children}
    </LibraryProcessingContextValue.Provider>
  );
}

export function LibraryProcessingContextOverride({
  value,
  children
}: {
  value: LibraryProcessingValue;
  children: ReactNode;
}) {
  return (
    <LibraryProcessingContextValue.Provider value={value}>
      {children}
    </LibraryProcessingContextValue.Provider>
  );
}

export function useLibraryProcessing(): LibraryProcessingValue {
  const value = useContext(LibraryProcessingContextValue);
  if (!value) throw new Error('useLibraryProcessing must be used inside LibraryProcessingProvider');
  return value;
}

/** Null outside a provider, for surfaces that may render without one. */
export function useOptionalLibraryProcessing(): LibraryProcessingValue | null {
  return useContext(LibraryProcessingContextValue);
}
