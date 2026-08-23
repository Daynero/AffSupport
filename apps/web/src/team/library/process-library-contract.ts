import type {
  LibraryJobClaimRequest,
  LibraryJobFinalizeRequest,
  LibraryJobFinalizeResult,
  LibraryJobHeartbeatRequest,
  TeamFileOperationResult,
  TeamProcessStartResult
} from '@video-compressor/shared';
import type { TeamLibraryAgentProcessRequest } from '../../api/client';
import type {
  LibraryJobClaimEnvelope,
  LibraryProcessingContext,
  LibraryRequirementScanResult,
  TeamProcessStartInput
} from '../../api/team';

const AGENT_INSTANCE_KEY = 'wishly.creative-library.agent-instance.v1';

/**
 * The server and agent surfaces the library batch drives.
 *
 * Extracted from the dialog so the provider that now owns the run and the
 * dialog that views it share one definition instead of importing each other.
 */
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

/**
 * One id per browser profile, reused across sessions.
 *
 * The server hands out leases to an agent instance; a fresh id each time would
 * orphan the lease this device already holds.
 */
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
