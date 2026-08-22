import {
  AGENT_TOOL_CONTRACTS,
  type AgentEntitlementStatus,
  type HealthResponse,
  type ImageSlot,
  type LandingPreviewRenderSettings,
  type LandingPreviewState,
  type LandingState,
  type PowerState,
  type LibraryJobKind,
  type QueueState,
  type SelectionResponse,
  type SelectionWarning,
  type ToolContracts,
  type TranscriptionDocument,
  type TranscriptionMediaPreview,
  type TranscriptionSettings,
  type TranscriptionState,
  type TranslationDocument,
  type TeamAgentProcessRequest,
  type TeamAgentPreviewResult,
  type TeamFileOperationResult,
  type TeamLandingAgentRenderResult,
  type TeamLandingPreviewCatalogRequest,
  type TeamLandingRenderJob,
  type TeamTransferGrant,
  normalizeToolContracts,
  parseTeamAgentPreviewResult,
  parseTeamFileOperationResult,
  toolContractCompatible
} from '@video-compressor/shared';
import { agentFetchOptions, pairingPath, probeAgent, versionState } from '../connection';
import { configuredAgentOrigin, publicConfig, servedByAgent } from '../lib/config';
import { pairingToken } from './pairing-token';
import type { DroppedFolderSample } from '../components/DropZone';

export const agentUrl = servedByAgent() ? location.origin : configuredAgentOrigin();
const privateNetworkInit = agentFetchOptions(agentUrl, location.origin);

// Storage, arrival and the re-pairing budget live in api/pairing-token: the token
// reaches the browser before authentication does, so it cannot wait for this
// module. Re-exported here because this is where the rest of the app expects it.
export {
  agentInstallAwaitingPairing,
  claimAutomaticPairing,
  consumePairingToken,
  hasPairingToken,
  markAgentInstallStarted,
  onPairingToken,
  releaseAutomaticPairing
} from './pairing-token';

/**
 * Pairing is needed before the Agent will answer.
 *
 * `agentAlive` records whether the Agent proved it is running while we found
 * out — a 401 is an answer, and so is a successful unauthenticated health
 * probe. The distinction decides whether re-pairing may happen on its own:
 * navigating to the pairing endpoint of an Agent that is not there replaces a
 * useful page with a dead loopback URL, which is why it is not done blind.
 *
 * The message stays `PAIRING_REQUIRED` so every existing `error.message`
 * comparison keeps working.
 */
export class PairingRequiredError extends Error {
  readonly agentAlive: boolean;
  constructor(agentAlive: boolean) {
    super('PAIRING_REQUIRED');
    this.name = 'PairingRequiredError';
    this.agentAlive = agentAlive;
  }
}

/** True when the Agent proved it is running as this failure was produced. */
export function agentProvenAlive(error: unknown) {
  // The Agent serves its own copy of this page, so reaching it proves as much.
  return servedByAgent() || (error instanceof PairingRequiredError && error.agentAlive);
}

export function pairWithAgent() {
  location.assign(`${agentUrl}${pairingPath(agentUrl, location.origin)}`);
}

export async function connect(signal?: AbortSignal): Promise<{
  state: QueueState | null;
  version: string;
  buildId: string;
  channel: string;
  apiVersion: number;
  capabilities: string[];
  toolContracts: ToolContracts;
  entitlement: AgentEntitlementStatus | null;
}> {
  if (!pairingToken()) {
    // Health answered, so the Agent is running and only the token is missing.
    await probeAgent(agentUrl, location.origin, signal);
    throw new PairingRequiredError(true);
  }
  const health = await request<Partial<HealthResponse> & { version: string }>(
    '/api/health',
    'GET',
    signal
  );
  const apiVersion = health.apiVersion ?? 0;
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
  const toolContracts = normalizeToolContracts(health.toolContracts, capabilities, apiVersion);
  const entitlement = health.entitlement ?? null;
  // An enforced agent without a valid token rejects every tool route, so the
  // caller must submit an entitlement token first and reconnect.
  const state =
    versionState(apiVersion) === 'connected' && !(entitlement?.enforced && !entitlement.entitled)
      ? await request<QueueState>('/api/queue', 'GET', signal)
      : null;
  return {
    state,
    version: health.version,
    buildId: health.buildId ?? '',
    channel: health.channel ?? 'unknown',
    apiVersion,
    capabilities,
    toolContracts,
    entitlement
  };
}
export function submitEntitlementToken(entitlementToken: string): Promise<AgentEntitlementStatus> {
  return requestBody<AgentEntitlementStatus>('/api/entitlement', { token: entitlementToken });
}
export function eventUrl() {
  return `${agentUrl}/api/events?token=${encodeURIComponent(pairingToken())}`;
}

/* ── Local resource budget ────────────────────────────────────────────────── */

export function fetchPowerState(signal?: AbortSignal): Promise<PowerState> {
  return request<PowerState>('/api/power', 'GET', signal);
}

/**
 * Sets the ceiling. The returned state is authoritative — an out-of-range value
 * comes back clamped, which is how the lever corrects itself without the client
 * needing to know the bounds.
 */
export function setPowerLimit(limitPercent: number): Promise<PowerState> {
  return requestBody<PowerState>('/api/power/limit', { limitPercent });
}

export function powerEventsUrl() {
  return `${agentUrl}/api/power/events?token=${encodeURIComponent(pairingToken())}`;
}
export async function request<T>(url: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  if (!pairingToken()) throw new PairingRequiredError(false);
  let response: Response;
  try {
    response = await fetch(agentUrl + url, {
      method,
      signal,
      cache: 'no-store',
      headers: { 'x-session-token': pairingToken() },
      ...privateNetworkInit
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('TIMEOUT', { cause: error });
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<T>;
}
export async function requestBody<T>(
  url: string,
  body: unknown,
  method = 'POST',
  signal?: AbortSignal
): Promise<T> {
  if (!pairingToken()) throw new PairingRequiredError(false);
  let response: Response;
  try {
    response = await fetch(agentUrl + url, {
      method,
      headers: { 'x-session-token': pairingToken(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      cache: 'no-store',
      ...privateNetworkInit
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('TIMEOUT', { cause: error });
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<T>;
}
export async function uploadFile(file: File): Promise<SelectionResponse> {
  const body = new FormData();
  body.append('signature', `${file.name}:${file.size}:${file.lastModified}`);
  body.append('size', String(file.size));
  body.append('lastModified', String(file.lastModified));
  body.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(agentUrl + '/api/files/upload', {
      method: 'POST',
      headers: { 'x-session-token': pairingToken() },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<SelectionResponse>;
}
export function addLocalFiles(paths: string[]): Promise<SelectionResponse> {
  return requestBody<SelectionResponse>(
    '/api/files/add',
    { paths },
    'POST',
    AbortSignal.timeout(10_000)
  );
}
export async function uploadImage(slot: ImageSlot, file: File): Promise<QueueState> {
  const body = new FormData();
  body.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(`${agentUrl}/api/images/${slot}`, {
      method: 'POST',
      headers: { 'x-session-token': pairingToken() },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<QueueState>;
}
export function imageContentUrl(id: string) {
  return `${agentUrl}/api/images/${encodeURIComponent(id)}/content?token=${encodeURIComponent(pairingToken())}`;
}
export function landingEventUrl() {
  return `${agentUrl}/api/landing/events?token=${encodeURIComponent(pairingToken())}`;
}
export function landingPreviewUrl(
  jobId: string,
  assetId: string,
  side: 'before' | 'after',
  variant: 'full' | 'thumbnail' = 'full'
) {
  const path = `/api/landing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(
    assetId
  )}/preview/${side}`;
  return `${agentUrl}${path}?variant=${variant}&token=${encodeURIComponent(pairingToken())}`;
}

export function landingGalleryEventUrl() {
  return `${agentUrl}/api/landing-preview/events?token=${encodeURIComponent(pairingToken())}`;
}

export function landingGalleryImageUrl(landingId: string, revision: number | null, segment = 0) {
  const suffix = revision ? `&v=${encodeURIComponent(revision)}` : '';
  return `${agentUrl}/api/landing-preview/landings/${encodeURIComponent(
    landingId
  )}/image?token=${encodeURIComponent(pairingToken())}&segment=${encodeURIComponent(segment)}${suffix}`;
}

function teamTransferRangeUrl() {
  if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  return `${publicConfig.value.supabaseUrl}/functions/v1/drive-transfer/range`;
}

function teamCloudBaseUrl() {
  if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  return `${publicConfig.value.supabaseUrl}/functions/v1/drive-ops`;
}

export interface TeamAgentPreviewRequest {
  operationId: string;
  transferGrant: TeamTransferGrant;
}

async function openTeamAgentPreview(
  kind: 'archive' | 'landing',
  input: TeamAgentPreviewRequest
): Promise<TeamAgentPreviewResult> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!toolContractCompatible('teamWorkspace', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value: unknown = await requestBody(`/api/team/preview/${kind}`, {
    operationId: input.operationId,
    transferGrant: input.transferGrant,
    transferUrl: teamTransferRangeUrl()
  });
  const parsed = parseTeamAgentPreviewResult(value);
  if (!parsed) throw new Error('INVALID_RESPONSE');
  return parsed;
}

export function openTeamArchivePreview(
  input: TeamAgentPreviewRequest
): Promise<TeamAgentPreviewResult> {
  return openTeamAgentPreview('archive', input);
}

export function openTeamLandingPreview(
  input: TeamAgentPreviewRequest
): Promise<TeamAgentPreviewResult> {
  return openTeamAgentPreview('landing', input);
}

export function teamLandingScreenshotUrl(operationId: string, segment = 0) {
  return `${agentUrl}/api/team/preview/${encodeURIComponent(
    operationId
  )}/screenshot?token=${encodeURIComponent(pairingToken())}&segment=${encodeURIComponent(segment)}`;
}

export async function closeTeamPreview(operationId: string): Promise<boolean> {
  const value = await request<{ closed?: unknown }>(
    `/api/team/preview/${encodeURIComponent(operationId)}`,
    'DELETE'
  );
  return value.closed === true;
}

export function teamEventUrl() {
  return `${agentUrl}/api/team/events?token=${encodeURIComponent(pairingToken())}`;
}

export function teamLandingEventUrl() {
  return `${agentUrl}/api/team/landings/events?token=${encodeURIComponent(pairingToken())}`;
}

export async function renderTeamLanding(
  input: TeamLandingRenderJob,
  signal?: AbortSignal
): Promise<TeamLandingAgentRenderResult> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET', signal);
  if ((health.toolContracts?.teamWorkspace ?? 0) < AGENT_TOOL_CONTRACTS.teamWorkspace) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value = await requestBody<Partial<TeamLandingAgentRenderResult>>(
    '/api/team/landings/render',
    input,
    'POST',
    signal
  );
  if (
    value.renderId !== input.renderId ||
    value.state !== 'ready' ||
    typeof value.segmentCount !== 'number' ||
    !Number.isInteger(value.segmentCount) ||
    value.segmentCount < 1 ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  return value as TeamLandingAgentRenderResult;
}

export async function cancelTeamLandingRender(operationId: string): Promise<boolean> {
  const value = await requestBody<{ canceled?: unknown }>(
    `/api/team/landings/render/${encodeURIComponent(operationId)}/cancel`,
    {}
  );
  return value.canceled === true;
}

export async function downloadTeamFileWithAgent(input: {
  transferUrl: string;
  transferGrant: TeamTransferGrant;
  fileName: string;
}): Promise<{ saved: true; fileName: string; sizeBytes: number }> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!toolContractCompatible('teamWorkspace', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value = await requestBody<{
    saved?: unknown;
    fileName?: unknown;
    sizeBytes?: unknown;
  }>('/api/team/download', {
    operationId: crypto.randomUUID(),
    transferUrl: input.transferUrl,
    transferGrant: input.transferGrant,
    fileName: input.fileName
  });
  if (
    value.saved !== true ||
    typeof value.fileName !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  return { saved: true, fileName: value.fileName, sizeBytes: value.sizeBytes };
}

export async function startTeamAgentProcess(
  input: TeamAgentProcessRequest
): Promise<TeamFileOperationResult> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!toolContractCompatible('teamWorkspace', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const tool =
    input.toolId === 'landingOptimizer'
      ? 'landingOptimizer'
      : input.toolId === 'transcription'
        ? 'transcription'
        : input.toolId === 'translation'
          ? 'transcription'
          : 'compressor';
  if (!toolContractCompatible(tool, health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value: unknown = await requestBody('/api/team/process', {
    ...input,
    transferUrl: teamTransferRangeUrl(),
    cloudBaseUrl: teamCloudBaseUrl()
  });
  const parsed = parseTeamFileOperationResult(value);
  if (!parsed) throw new Error('INVALID_RESPONSE');
  return parsed;
}

export interface TeamLibraryAgentProcessRequest {
  operationId: string;
  teamId: string;
  requirementId: string;
  attemptId: string;
  agentInstanceId: string;
  kind: LibraryJobKind;
  variant: string;
  sourceVersion: string;
  leaseToken: string;
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
  options: unknown;
}

export async function startTeamLibraryAgentProcess(
  input: TeamLibraryAgentProcessRequest
): Promise<TeamFileOperationResult> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!toolContractCompatible('teamWorkspace', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const tool = input.kind === 'landing_optimization' ? 'landingOptimizer' : 'transcription';
  if (!toolContractCompatible(tool, health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value: unknown = await requestBody('/api/team/library/process', {
    ...input,
    transferUrl: teamTransferRangeUrl(),
    cloudBaseUrl: teamCloudBaseUrl()
  });
  const parsed = parseTeamFileOperationResult(value);
  if (!parsed) throw new Error('INVALID_RESPONSE');
  return parsed;
}

export async function cancelTeamLibraryAgentProcess(attemptId: string): Promise<boolean> {
  const value = await requestBody<{ canceled?: unknown }>(
    `/api/team/library/process/${encodeURIComponent(attemptId)}/cancel`,
    {}
  );
  return value.canceled === true;
}

export async function cancelTeamAgentProcess(operationId: string): Promise<boolean> {
  const value = await requestBody<{ canceled?: unknown }>(
    `/api/team/process/${encodeURIComponent(operationId)}/cancel`,
    {}
  );
  return value.canceled === true;
}

export function landingGallerySelect(): Promise<LandingPreviewState> {
  return request<LandingPreviewState>('/api/landing-preview/select', 'POST');
}

export function landingGalleryOpen(paths: string[]): Promise<LandingPreviewState> {
  return requestBody<LandingPreviewState>('/api/landing-preview/open', { paths });
}

/**
 * Recover a dropped folder's local path from a sample file inside it (browsers hide the path). The
 * caller opens the returned path through {@link landingGalleryOpen}, so drag-and-drop lands on the
 * same catalogue the picker would. Resolves to `null` when the folder can't be located on disk.
 */
export function landingGalleryResolveDrop(sample: DroppedFolderSample): Promise<string | null> {
  return requestBody<{ path: string | null }>('/api/landing-preview/resolve-drop', sample).then(
    result => result.path
  );
}

export async function landingGalleryOpenTeamSpace(
  snapshot: TeamLandingPreviewCatalogRequest
): Promise<LandingPreviewState> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if ((health.toolContracts?.teamWorkspace ?? 0) < AGENT_TOOL_CONTRACTS.teamWorkspace) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  return requestBody<LandingPreviewState>('/api/landing-preview/team-space', snapshot);
}

export function landingGalleryActivate(catalogId: string): Promise<LandingPreviewState> {
  return request<LandingPreviewState>(
    `/api/landing-preview/catalogs/${encodeURIComponent(catalogId)}/activate`,
    'POST'
  );
}

export function landingGalleryRefresh(
  mode: 'changed' | 'all' | 'current',
  landingId?: string
): Promise<LandingPreviewState> {
  return requestBody<LandingPreviewState>('/api/landing-preview/refresh', {
    mode,
    ...(landingId ? { landingId } : {})
  });
}

export function landingGalleryCancel(): Promise<LandingPreviewState> {
  return request<LandingPreviewState>('/api/landing-preview/cancel', 'POST');
}

export function landingGalleryReveal(landingId: string): Promise<LandingPreviewState> {
  return request<LandingPreviewState>(
    `/api/landing-preview/landings/${encodeURIComponent(landingId)}/reveal`,
    'POST'
  );
}

export function landingGalleryOpenExtracted(landingId: string): Promise<LandingPreviewState> {
  return request<LandingPreviewState>(
    `/api/landing-preview/landings/${encodeURIComponent(landingId)}/open-extracted`,
    'POST'
  );
}

export function landingGalleryClearCache(): Promise<LandingPreviewState> {
  return request<LandingPreviewState>('/api/landing-preview/cache', 'DELETE');
}

export function landingGalleryRemoveCatalog(catalogId: string): Promise<LandingPreviewState> {
  return request<LandingPreviewState>(
    `/api/landing-preview/catalogs/${encodeURIComponent(catalogId)}`,
    'DELETE'
  );
}

export function landingGallerySettings(
  partial: Partial<LandingPreviewRenderSettings>
): Promise<LandingPreviewState> {
  return requestBody<LandingPreviewState>('/api/landing-preview/settings', partial);
}
async function uploadForm<T>(url: string, body: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(agentUrl + url, {
      method: 'POST',
      headers: { 'x-session-token': pairingToken() },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<T>;
}
export async function uploadLandingZip(file: File): Promise<LandingState> {
  const body = new FormData();
  // Size/lastModified let the agent match the dropped archive back to the
  // original on disk (findDroppedSource) so the optimized result lands next to
  // it, mirroring the video compressor's "next to originals" behavior.
  body.append('signature', `${file.name}:${file.size}:${file.lastModified}`);
  body.append('size', String(file.size));
  body.append('lastModified', String(file.lastModified));
  body.append('file', file, file.name);
  return uploadForm<LandingState>('/api/landing/upload/zip', body);
}
export async function landingFolderBegin(name: string): Promise<LandingState> {
  return requestBody<LandingState>('/api/landing/upload/folder/begin', { name });
}
export async function landingFolderFile(relPath: string, file: File): Promise<{ ok: boolean }> {
  const body = new FormData();
  body.append('relPath', relPath);
  body.append('file', file, file.name);
  return uploadForm<{ ok: boolean }>('/api/landing/upload/folder/file', body);
}
export async function landingFolderFinish(): Promise<LandingState> {
  return request<LandingState>('/api/landing/upload/folder/finish', 'POST');
}

export interface TranscriptionSelectionResponse {
  state: TranscriptionState;
  warnings: SelectionWarning[];
}
export function transcriptionEventUrl() {
  return `${agentUrl}/api/transcription/events?token=${encodeURIComponent(pairingToken())}`;
}
export function transcriptionSettings(
  patch: Partial<TranscriptionSettings>
): Promise<TranscriptionState> {
  return requestBody<TranscriptionState>('/api/transcription/settings', patch);
}
export function transcriptionSelect(): Promise<TranscriptionSelectionResponse> {
  return request<TranscriptionSelectionResponse>('/api/transcription/select', 'POST');
}
export function transcriptionAddLocalFiles(
  paths: string[]
): Promise<TranscriptionSelectionResponse> {
  return requestBody<TranscriptionSelectionResponse>(
    '/api/transcription/files/add',
    { paths },
    'POST',
    AbortSignal.timeout(10_000)
  );
}
export async function transcriptionUpload(file: File): Promise<TranscriptionSelectionResponse> {
  const body = new FormData();
  body.append('signature', `${file.name}:${file.size}:${file.lastModified}`);
  body.append('size', String(file.size));
  body.append('lastModified', String(file.lastModified));
  body.append('file', file, file.name);
  return uploadForm<TranscriptionSelectionResponse>('/api/transcription/files/upload', body);
}
export function transcriptionStart(ids: string[]): Promise<TranscriptionState> {
  return requestBody<TranscriptionState>('/api/transcription/start', { ids });
}
export function transcriptionModelDownload(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/model/download', 'POST');
}
export function transcriptionModelCancel(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/model/cancel', 'POST');
}
export function transcriptionTranslatorDownload(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/translator/download', 'POST');
}
export function transcriptionTranslatorCancel(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/translator/cancel', 'POST');
}
export function transcriptionCancel(id: string): Promise<TranscriptionState> {
  return request<TranscriptionState>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/cancel`,
    'POST'
  );
}
export function transcriptionCancelAll(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/cancel-all', 'POST');
}
export function transcriptionRetry(id: string): Promise<TranscriptionState> {
  return request<TranscriptionState>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/retry`,
    'POST'
  );
}
export function transcriptionRemove(id: string): Promise<TranscriptionState> {
  return request<TranscriptionState>(`/api/transcription/jobs/${encodeURIComponent(id)}`, 'DELETE');
}
export function transcriptionRemoveMany(ids: string[]): Promise<TranscriptionState> {
  return requestBody<TranscriptionState>('/api/transcription/jobs/remove', { ids });
}
export function transcriptionClearFinished(): Promise<TranscriptionState> {
  return request<TranscriptionState>('/api/transcription/completed', 'DELETE');
}
export function transcriptionReveal(id: string): Promise<TranscriptionState> {
  return request<TranscriptionState>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/reveal`,
    'POST'
  );
}
export function transcriptionDocument(
  id: string,
  signal?: AbortSignal
): Promise<TranscriptionDocument> {
  return request<TranscriptionDocument>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/document`,
    'GET',
    signal
  );
}
export function transcriptionTranslate(
  id: string,
  targetLanguage: string,
  requestId?: string
): Promise<TranslationDocument> {
  return requestBody<TranslationDocument>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/translations`,
    { targetLanguage, requestId }
  );
}
export function transcriptionSaveWithTranslation(
  id: string,
  options: { languageLabel: string; fileName: string }
): Promise<TranscriptionState> {
  return requestBody<TranscriptionState>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/save-with-translation`,
    options
  );
}
export function transcriptionTranslationCancel(id: string): Promise<TranscriptionState> {
  return request<TranscriptionState>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/translations`,
    'DELETE'
  );
}
export function transcriptionTranslation(
  id: string,
  language: string,
  signal?: AbortSignal
): Promise<TranslationDocument> {
  return request<TranslationDocument>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/translations/${encodeURIComponent(language)}`,
    'GET',
    signal
  );
}
export function transcriptionMediaStatus(
  id: string,
  signal?: AbortSignal
): Promise<TranscriptionMediaPreview> {
  return request<TranscriptionMediaPreview>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/media/status`,
    'GET',
    signal
  );
}
export function transcriptionMediaPrepare(id: string): Promise<TranscriptionMediaPreview> {
  return request<TranscriptionMediaPreview>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/media/prepare`,
    'POST'
  );
}
export function transcriptionMediaCancel(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/transcription/jobs/${encodeURIComponent(id)}/media/cancel`,
    'POST'
  );
}
/** URL for the local, token-gated, range-capable source media (for the player). */
export function transcriptionMediaUrl(id: string): string {
  return `${agentUrl}/api/transcription/jobs/${encodeURIComponent(id)}/media?token=${encodeURIComponent(pairingToken())}`;
}
async function assertOk(response: Response) {
  // Decided before the body is read: a 401 came *from* the Agent, so it is
  // running and only this token is stale — the normal state after a restart
  // minted a new one. Parsing first would turn an unparseable 401 body into a
  // generic failure and cost us that fact.
  if (response.status === 401) throw new PairingRequiredError(true);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'AGENT_ERROR');
  return body;
}
