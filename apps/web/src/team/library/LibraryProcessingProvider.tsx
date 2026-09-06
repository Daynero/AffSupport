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
  type LibraryBatchScope,
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

/**
 * How the last run ended, kept after the counts move on.
 *
 * The window rescans as soon as a run settles, so the numbers over Start
 * describe what is left rather than what was just offered. That would have
 * wiped the run's own result off the screen in the same frame; this holds it
 * until a new run starts or the scope changes.
 */
export interface LibraryBatchOutcome {
  kind: 'complete' | 'canceled' | 'failed';
  done: number;
  skipped: number;
  failed: number;
  failedNames: string[];
}

export interface LibraryProcessingValue {
  phase: LibraryProcessingPhase;
  outcome: LibraryBatchOutcome | null;
  /**
   * The scope these numbers are about. Not always the one last asked for: a
   * scope change during a run is held until the run ends, and a window that
   * showed the requested one would put a new title over the old run's progress.
   */
  scope: LibraryBatchScope;
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

/** The run's tally, as the shape the outcome keeps. */
function snapshot(counts: { done: number; skipped: number; failed: number; names: string[] }) {
  return {
    done: counts.done,
    skipped: counts.skipped,
    failed: counts.failed,
    failedNames: [...counts.names]
  };
}

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
  sourceMaterialIds,
  scope = { kind: 'space' },
  agentCompatible,
  toolContracts,
  client = teamApi,
  agent = defaultAgent,
  agentInstanceId,
  onChanged,
  children
}: {
  teamId: string;
  /**
   * What this batch is about: left out (or empty) for the whole space, one id
   * for a single file, several for a folder or a hand-picked set. Choosing five
   * videos and processing exactly those five is the ordinary request; it used
   * to be impossible — the button either started work on everything or, once
   * that lie was removed, disappeared.
   */
  sourceMaterialIds?: readonly string[];
  /** The same scope in words, for whoever is showing the batch. */
  scope?: LibraryBatchScope;
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
  const [outcome, setOutcome] = useState<LibraryBatchOutcome | null>(null);
  const control = useRef({
    stopped: false,
    attempt: null as LibraryJobClaimEnvelope | null,
    operationId: null as string | null
  });

  /**
   * The scope, as one list, so the scan and the claim loop share a single
   * notion of what the batch is about. Empty means the whole space.
   */
  /* Derived from the key rather than from the prop: a caller that rebuilds the
     array on every render would otherwise hand this a new identity each time,
     and every callback below — the scan among them — would be rebuilt with it. */
  const sourcesKey = (sourceMaterialIds ?? []).join(',');
  const sources = useMemo(() => (sourcesKey === '' ? [] : sourcesKey.split(',')), [sourcesKey]);

  /*
   * A different scope is a different batch. The window only rescans while the
   * batch is idle, so without this a run that finished over four chosen files
   * left its counts and its tally standing — and opening the window on the
   * whole space next showed that finished run's numbers under the new title.
   * A run in flight is left alone: it is working through the set it started
   * with, and its progress is the true thing on screen.
   */
  const [appliedScope, setAppliedScope] = useState<LibraryBatchScope>(scope);
  /* The words for the scope, kept beside the key rather than in the effect's
     dependencies: the two change together, and the key is what decides whether
     anything changed at all. */
  const requestedScope = useRef(scope);
  requestedScope.current = scope;
  /*
   * The scope's identity is its ids *and* its name. Keying on the ids alone
   * left the window titled "Папка «A»" after hand-picking exactly the files
   * that folder held — the same work under the wrong name.
   */
  const scopeKey = `${sourcesKey}|${scope.kind}|${'name' in scope ? scope.name : ''}`;
  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    // Marked as handled only once it has been: claiming it while a run is in
    // flight meant the scope change was swallowed and never applied at all.
    if (phase === 'running' || phase === 'scanning') return;
    lastScope.current = scopeKey;
    setAppliedScope(requestedScope.current);
    setPhase('idle');
    setScan(null);
    setActiveKind(null);
    setDone(0);
    setSkipped(0);
    setFailed(0);
    setFailedNames([]);
    setErrorCode(null);
    setOutcome(null);
  }, [phase, scopeKey]);

  const supportedKinds = useMemo<LibraryJobKind[]>(() => {
    if (!agentCompatible || (toolContracts.teamWorkspace ?? 0) < 1) return [];
    const kinds: LibraryJobKind[] = [];
    if ((toolContracts.transcription ?? 0) >= 5) kinds.push('transcription', 'translation');
    /*
     * Landings too, whatever the scope. This used to be space-only, on the
     * reasoning that one chosen video does not ask for landing work — true, and
     * harmless, because the scan of one video finds no landings anyway. What it
     * cost was a folder batch that counted six landing jobs in its own window
     * and could not claim a single one: eighteen of twenty-four, then "this
     * computer has finished all the compatible work" beside a tile reading 6.
     */
    if ((toolContracts.landingOptimizer ?? 0) >= 2) kinds.push('landing_optimization');
    return kinds;
  }, [agentCompatible, toolContracts]);

  const rescan = useCallback(async () => {
    setPhase('scanning');
    setErrorCode(null);
    /* A scan describes what is left, so the live tally stops being this
       batch's progress. The finished run's result survives in `outcome`. */
    setDone(0);
    setSkipped(0);
    setFailed(0);
    setFailedNames([]);
    setActiveKind(null);
    try {
      /* Counting only. Opening this window used to enqueue every job it
         counted, for everyone in the space, while saying nothing starts
         without confirmation. Start is what enqueues now. */
      setScan(await client.scanLibraryRequirements(teamId, language, sources, false));
      setPhase('ready');
    } catch (error) {
      setErrorCode(safeErrorCode(error));
      setPhase('failed');
    }
  }, [client, language, sources, teamId]);

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

  /*
   * What this device will actually claim, not what the space is missing. An
   * agent without the landing tool still sees the landing count in the scan;
   * adding it here promised jobs the loop would never ask for, and the batch
   * then ended "complete" several short of its own number.
   */
  const total = scan
    ? (supportedKinds.includes('transcription') ? scan.missing.transcription : 0) +
      (supportedKinds.includes('translation') ? scan.missing.translation : 0) +
      (supportedKinds.includes('landing_optimization') ? scan.missing.landingOptimization : 0)
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
          text: t('teamBatchSummaryPartial', {
            done: counts.done,
            failed: counts.failed,
            names: counts.names.slice(0, 3).join(', ')
          })
        });
        return;
      }
      if (counts.done === 0 && counts.skipped === 0) {
        push({ tone: 'info', text: t('teamBatchSummaryNothing') });
        return;
      }
      push({
        tone: 'success',
        text: t('teamBatchSummaryDone', { done: counts.done })
      });
    },
    [push, t]
  );

  const start = useCallback(async () => {
    if (supportedKinds.length === 0) return;
    control.current.stopped = false;
    setPhase('running');
    /* The queue is written here, at the press that agreed to it. Until now the
       window had only counted. */
    try {
      await client.scanLibraryRequirements(teamId, language, sources, true);
    } catch (error) {
      setErrorCode(safeErrorCode(error));
      setPhase('failed');
      return;
    }
    setErrorCode(null);
    /* A run counts itself. Carrying the previous run's tally forward put the
       progress bar near full before anything had happened, and the results line
       claimed ten files done at the moment Start was pressed. */
    setOutcome(null);
    setDone(0);
    setSkipped(0);
    setFailed(0);
    setFailedNames([]);
    const counts = { done: 0, skipped: 0, failed: 0, names: [] as string[] };
    for (;;) {
      if (control.current.stopped) return;
      let job: LibraryJobClaimEnvelope;
      try {
        /* The scope travels with every claim: the server hands out one job at
           a time from the whole set, so a folder of fifty finishes on the same
           loop that finishes a single file. */
        job = await client.claimLibraryJob({
          teamId,
          agentInstanceId: instanceId,
          supportedKinds,
          interfaceLanguage: language,
          ...(sources.length > 0 ? { sourceMaterialIds: sources } : {})
        });
      } catch (error) {
        if (safeErrorCode(error) === 'NO_WORK') {
          setActiveKind(null);
          // The result is kept before the rescan replaces the live tally: what
          // this run did stays on screen while the numbers move to what is left.
          setOutcome({ kind: 'complete', ...snapshot(counts) });
          await rescan();
          setPhase('complete');
          summarize(counts);
          onChanged?.();
          return;
        }
        setErrorCode(safeErrorCode(error));
        setOutcome({ kind: 'failed', ...snapshot(counts) });
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
    sources,
    summarize,
    supportedKinds,
    teamId,
    toolContracts.landingOptimizer,
    toolContracts.transcription
  ]);

  /** Stopping on purpose, which is a different outcome from the run failing. */
  const cancel = useCallback(async () => {
    await releaseActive();
    setOutcome({
      kind: 'canceled',
      done,
      skipped,
      failed,
      failedNames
    });
    setPhase('canceled');
    push({ tone: 'info', text: t('teamBatchCanceled') });
  }, [done, failed, failedNames, push, releaseActive, skipped, t]);

  const retryFailed = useCallback(async () => {
    try {
      await client.retryFailedLibraryJobs(teamId, sources);
      setFailed(0);
      setFailedNames([]);
      await start();
    } catch (error) {
      const code = safeErrorCode(error);
      setErrorCode(code);
      push({ tone: 'error', text: teamErrorMessage(code, t) });
    }
  }, [client, push, sources, start, t, teamId]);

  const value = useMemo<LibraryProcessingValue>(
    () => ({
      phase,
      outcome,
      scope: appliedScope,
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
      appliedScope,
      cancel,
      done,
      errorCode,
      failed,
      failedNames,
      outcome,
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
