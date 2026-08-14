import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  transcriptSidecarName,
  translationSidecarName,
  type LibraryJobClaimRequest,
  type LibraryJobFinalizeRequest,
  type LibraryJobFinalizeResult,
  type LibraryJobHeartbeatRequest,
  type LibraryJobKind,
  type ToolContracts,
  type TeamFileOperationResult,
  type TeamProcessStartResult
} from '@video-compressor/shared';
import {
  cancelTeamLibraryAgentProcess,
  startTeamLibraryAgentProcess,
  type TeamLibraryAgentProcessRequest
} from '../../api/client';
import {
  teamApi,
  TeamApiError,
  type LibraryJobClaimEnvelope,
  type LibraryProcessingContext,
  type LibraryRequirementScanResult,
  type TeamProcessStartInput
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

const AGENT_INSTANCE_KEY = 'wishly.creative-library.agent-instance.v1';
const HEARTBEAT_MS = 25_000;

export interface ProcessLibraryClient {
  scanLibraryRequirements(
    teamId: string,
    interfaceLanguage: string,
    sourceMaterialId?: string
  ): Promise<LibraryRequirementScanResult>;
  claimLibraryJob(input: LibraryJobClaimRequest): Promise<LibraryJobClaimEnvelope>;
  getLibraryProcessingContext(
    teamId: string,
    sourceMaterialId: string
  ): Promise<LibraryProcessingContext>;
  startProcess(input: TeamProcessStartInput): Promise<TeamProcessStartResult>;
  heartbeatLibraryJob(input: LibraryJobHeartbeatRequest): Promise<unknown>;
  cancelLibraryJob(input: {
    teamId: string;
    attemptId: string;
    agentInstanceId: string;
    leaseToken: string;
  }): Promise<boolean>;
  failLibraryJob(input: {
    teamId: string;
    attemptId: string;
    agentInstanceId: string;
    leaseToken: string;
    errorCode: string;
  }): Promise<boolean>;
  retryFailedLibraryJobs(teamId: string, sourceMaterialId?: string): Promise<number>;
  finalizeLibraryJob(input: LibraryJobFinalizeRequest): Promise<LibraryJobFinalizeResult>;
  cancelOperation(teamId: string, operationId: string): Promise<unknown>;
}

export interface ProcessLibraryAgent {
  process(input: TeamLibraryAgentProcessRequest): Promise<TeamFileOperationResult>;
  cancel(attemptId: string): Promise<boolean>;
}

const defaultAgent: ProcessLibraryAgent = {
  process: startTeamLibraryAgentProcess,
  cancel: cancelTeamLibraryAgentProcess
};

export function stableLibraryAgentInstanceId(
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  create: () => string = () => crypto.randomUUID()
): string {
  const current = storage.getItem(AGENT_INSTANCE_KEY);
  if (current && /^[0-9a-f-]{36}$/iu.test(current)) return current;
  const created = create();
  storage.setItem(AGENT_INSTANCE_KEY, created);
  return created;
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

type RunPhase = 'scanning' | 'confirm' | 'running' | 'paused' | 'complete' | 'failed';

export function ProcessLibraryDialog({
  teamId,
  sourceMaterialId,
  agentCompatible,
  toolContracts,
  client = teamApi,
  agent = defaultAgent,
  agentInstanceId,
  onClose,
  onChanged
}: {
  teamId: string;
  sourceMaterialId?: string;
  agentCompatible: boolean;
  toolContracts: ToolContracts;
  client?: ProcessLibraryClient;
  agent?: ProcessLibraryAgent;
  agentInstanceId?: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { language, t } = useI18n();
  const instanceId = useMemo(
    () => agentInstanceId ?? stableLibraryAgentInstanceId(),
    [agentInstanceId]
  );
  const [phase, setPhase] = useState<RunPhase>('scanning');
  const [scan, setScan] = useState<LibraryRequirementScanResult | null>(null);
  const [completed, setCompleted] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [failed, setFailed] = useState(0);
  const [activeKind, setActiveKind] = useState<LibraryJobKind | null>(null);
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

  const refreshScan = useCallback(async () => {
    setPhase('scanning');
    setErrorCode(null);
    try {
      const result = await client.scanLibraryRequirements(teamId, language, sourceMaterialId);
      setScan(result);
      setPhase('confirm');
      return result;
    } catch (error) {
      setErrorCode(safeErrorCode(error));
      setPhase('failed');
      return null;
    }
  }, [client, language, sourceMaterialId, teamId]);

  useEffect(() => {
    void refreshScan();
  }, [refreshScan]);

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

  useEffect(
    () => () => {
      if (control.current.attempt) void releaseActive();
    },
    [releaseActive]
  );

  const run = useCallback(async () => {
    if (supportedKinds.length === 0) return;
    control.current.stopped = false;
    setPhase('running');
    setErrorCode(null);
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
          setPhase('complete');
          setActiveKind(null);
          await refreshScan();
          setPhase('complete');
          onChanged?.();
          return;
        }
        setErrorCode(safeErrorCode(error));
        setPhase('failed');
        return;
      }

      control.current.attempt = job;
      setActiveKind(job.kind);
      let operationId: string | null = null;
      let heartbeat: number | null = null;
      try {
        const context = await client.getLibraryProcessingContext(teamId, job.sourceMaterialId);
        const toolId = toolForKind(job.kind);
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
          toolId,
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
        if (finalized.state === 'accepted') setCompleted(value => value + 1);
        else setSkipped(value => value + 1);
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
        setFailed(value => value + 1);
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
    refreshScan,
    sourceMaterialId,
    supportedKinds,
    teamId,
    toolContracts.landingOptimizer,
    toolContracts.transcription
  ]);

  const totalMissing = scan
    ? scan.missing.transcription + scan.missing.translation + scan.missing.landingOptimization
    : 0;

  return (
    <Modal
      labelledBy="creative-library-process-title"
      onClose={() => {
        void releaseActive().finally(onClose);
      }}
      closeLabel={t('teamCancel')}
      size="lg"
    >
      <section className="creative-library-process">
        <p className="team-workspace-eyebrow">{t('creativeLibraryProcessEyebrow')}</p>
        <h2 id="creative-library-process-title">
          {sourceMaterialId
            ? t('creativeLibraryTranscribeVideoTitle')
            : t('creativeLibraryProcessTitle')}
        </h2>
        {phase === 'scanning' && <p aria-live="polite">{t('creativeLibraryProcessScanning')}</p>}
        {scan && (
          <div
            className="creative-library-process-counts"
            aria-label={t('creativeLibraryProcessCounts')}
          >
            <div>
              <strong>{scan.missing.transcription}</strong>
              <span>{t('creativeLibraryProcessTranscriptions')}</span>
            </div>
            <div>
              <strong>{scan.missing.translation}</strong>
              <span>{t('creativeLibraryProcessTranslations')}</span>
            </div>
            {!sourceMaterialId && (
              <div>
                <strong>{scan.missing.landingOptimization}</strong>
                <span>{t('creativeLibraryProcessLandings')}</span>
              </div>
            )}
          </div>
        )}
        {phase === 'confirm' && totalMissing > 0 && (
          <p>{t('creativeLibraryProcessConfirmation', { count: totalMissing })}</p>
        )}
        {phase === 'confirm' && totalMissing === 0 && <p>{t('creativeLibraryProcessNothing')}</p>}
        {!agentCompatible && <p className="team-inline-error">{t('teamProcessAgentUpdate')}</p>}
        {agentCompatible && supportedKinds.length === 0 && (
          <p className="team-inline-error">{t('teamProcessToolUpdate')}</p>
        )}
        {phase === 'running' && (
          <div className="creative-library-process-progress" aria-live="polite">
            <progress
              max={Math.max(totalMissing, completed + skipped + failed, 1)}
              value={completed + skipped + failed}
            />
            <span>
              {t('creativeLibraryProcessProgress', {
                completed,
                total: Math.max(totalMissing, completed + skipped + failed)
              })}
            </span>
            {activeKind && <small>{t('creativeLibraryProcessActive', { kind: activeKind })}</small>}
          </div>
        )}
        {(completed > 0 || skipped > 0 || failed > 0) && (
          <p>{t('creativeLibraryProcessResults', { completed, skipped, failed })}</p>
        )}
        {phase === 'paused' && <p>{t('creativeLibraryProcessPaused')}</p>}
        {phase === 'complete' && <p>{t('creativeLibraryProcessComplete')}</p>}
        {errorCode && (
          <p className="team-inline-error">
            {t('creativeLibraryProcessFailed', { code: errorCode })}
          </p>
        )}
        <div className="team-dialog-actions">
          {phase === 'confirm' && totalMissing > 0 && (
            <Button
              type="button"
              variant="primary"
              disabled={supportedKinds.length === 0}
              onClick={() => void run()}
            >
              {t('creativeLibraryProcessStart')}
            </Button>
          )}
          {phase === 'running' && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void releaseActive().then(() => setPhase('paused'))}
            >
              {t('creativeLibraryProcessPause')}
            </Button>
          )}
          {phase === 'paused' && (
            <Button type="button" variant="primary" onClick={() => void run()}>
              {t('creativeLibraryProcessResume')}
            </Button>
          )}
          {failed > 0 && phase !== 'running' && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void client.retryFailedLibraryJobs(teamId, sourceMaterialId).then(run)}
            >
              {t('creativeLibraryProcessRetry')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void releaseActive().finally(onClose)}
          >
            {t('creativeLibraryDone')}
          </Button>
        </div>
      </section>
    </Modal>
  );
}
