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
  type TeamRestitchDefaults,
  parseMaterialRestitchPrep,
  type MaterialRestitchPrep,
  normalizeToolContracts,
  parseTeamAgentPreviewResult,
  parseTeamFileOperationResult,
  teamPosterFrameSupported,
  teamProcessPauseSupported,
  toolContractCompatible
} from '@video-compressor/shared';
import { agentFetchOptions, pairingPath, probeAgent, versionState } from '../connection';
import { configuredAgentOrigin, publicConfig, servedByAgent } from '../lib/config';
import { pairingToken } from './pairing-token';
import type { DroppedFolderSample } from '../components/DropZone';
import {
  imageContentPath,
  landingPreviewPath,
  subresourceTicket,
  transcriptionMediaPath
} from './subresource-paths';

export { imageContentPath, landingPreviewPath, transcriptionMediaPath };

export const agentUrl = servedByAgent() ? location.origin : configuredAgentOrigin();
const privateNetworkInit = agentFetchOptions(agentUrl, location.origin);

// Storage, arrival and the re-pairing budget live in api/pairing-token: the token
// reaches the browser before authentication does, so it cannot wait for this
// module. Re-exported here because this is where the rest of the app expects it.
export {
  agentInstallAwaitingPairing,
  agentKnown,
  claimAutomaticPairing,
  consumePairingToken,
  hasPairingToken,
  markAgentInstallStarted,
  markAgentSeen,
  onPairingToken,
  releaseAutomaticPairing,
  verifyPairingToken
} from './pairing-token';

/**
 * The Agent's own copy of the app, carrying the page the user was trying to reach.
 *
 * Every screen that says "we cannot reach Soty" offers this link, and for the
 * browsers that block loopback outright it is the only way through. Landing on
 * the Agent's home screen instead of the tool that was asked for turns one
 * click into three, so the destination travels in `?to=`; the Agent redirects
 * through it on the way to handing back a pairing token.
 *
 * Older Agents ignore the parameter and open their home screen, which is
 * exactly what they did before — the link never has to know which build is
 * installed.
 *
 * Only a same-origin path is ever forwarded. The Agent validates this again on
 * its side; a caller cannot be the only thing standing between a crafted URL
 * and a redirect.
 */
export function agentLocalUrl(to: string = location.pathname + location.search) {
  const internal = to.startsWith('/') && !to.startsWith('//') && !to.includes('#');
  return internal && to !== '/'
    ? `${agentUrl}/local?to=${encodeURIComponent(to)}`
    : `${agentUrl}/local`;
}

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
  /** Identifies this run of the agent; changes on every restart. */
  instanceId: string;
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
    instanceId: health.instanceId ?? health.buildId ?? '',
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
/**
 * The per-tool live-update endpoints, kept as the fallback for an agent that does not
 * advertise `event-stream`.
 *
 * One builder, not seven. Every one of these carries the session token as a **query
 * parameter**, which is the one place a secret must never be — it lands in server logs, in a
 * `Referer`, and in whatever the browser remembers about the page. That is precisely why the
 * multiplexed stream sends it as a header instead, and why this shape is worth keeping in a
 * single place while it lasts rather than repeated at seven call sites.
 */
const TOOL_EVENT_PATHS = {
  compressor: '/api/events',
  landing: '/api/landing/events',
  'landing-preview': '/api/landing-preview/events',
  transcription: '/api/transcription/events',
  stitcher: '/api/stitcher/events',
  team: '/api/team/events',
  'team-landings': '/api/team/landings/events',
  power: '/api/power/events'
} as const;

export type ToolEventChannel = keyof typeof TOOL_EVENT_PATHS;

export function toolEventUrl(channel: ToolEventChannel): string {
  return `${agentUrl}${TOOL_EVENT_PATHS[channel]}?token=${encodeURIComponent(pairingToken())}`;
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

/** Builds a subresource URL carrying a ticket, or null when none could be had. */
export async function ticketedUrl(
  path: string,
  extra: Record<string, string> = {}
): Promise<string | null> {
  const ticket = await subresourceTicket(agentUrl, pairingToken(), path);
  if (!ticket) return null;
  const query = new URLSearchParams({ ...extra, ticket });
  return `${agentUrl}${path}?${query.toString()}`;
}

export async function imageContentUrl(id: string): Promise<string | null> {
  return ticketedUrl(imageContentPath(id));
}
export function landingPreviewUrl(
  jobId: string,
  assetId: string,
  side: 'before' | 'after',
  variant: 'full' | 'thumbnail' = 'full'
): Promise<string | null> {
  const path = `/api/landing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(
    assetId
  )}/preview/${side}`;
  return ticketedUrl(path, { variant });
}

export function landingGalleryImageUrl(
  landingId: string,
  revision: number | null,
  segment = 0
): Promise<string | null> {
  const path = `/api/landing-preview/landings/${encodeURIComponent(landingId)}/image`;
  return ticketedUrl(path, {
    segment: String(segment),
    ...(revision ? { v: String(revision) } : {})
  });
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
  operationId?: string;
  transferUrl: string;
  transferGrant: TeamTransferGrant;
  fileName: string;
  /** A folder already chosen for this space; without it the agent opens its picker. */
  destination?: string | null;
  /** 013 (B5): compress after downloading, before saving locally. */
  compress?: { embed: boolean; suffix: string };
  /** 015: re-stitch after downloading, with the space's defaults. */
  process?:
    | { tool: 'compressor'; embed: boolean; suffix: string }
    | {
        tool: 'restitch';
        defaults: TeamRestitchDefaults;
        prepared?: MaterialRestitchPrep | null;
        suffix?: string;
      };
}): Promise<{
  saved: true;
  fileName: string;
  sizeBytes: number;
  /** The folder it landed in, so the caller can stop asking. */
  destination: string | null;
  /** What the run had to work out for itself, when nobody had prepared this material. */
  discovered?: unknown;
}> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!toolContractCompatible('teamWorkspace', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  if (input.process?.tool === 'restitch' && !toolContractCompatible('stitcher', health.toolContracts ?? {})) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value = await requestBody<{
    saved?: unknown;
    fileName?: unknown;
    sizeBytes?: unknown;
    destination?: unknown;
    discovered?: unknown;
  }>('/api/team/download', {
    operationId: input.operationId ?? crypto.randomUUID(),
    transferUrl: input.transferUrl,
    transferGrant: input.transferGrant,
    fileName: input.fileName,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.process ? { process: input.process } : {}),
    ...(input.compress ? { compress: input.compress } : {})
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
  return {
    saved: true,
    fileName: value.fileName,
    sizeBytes: value.sizeBytes,
    destination: typeof value.destination === 'string' ? value.destination : null,
    // Passed through untouched: the caller narrows it before storing, and a run that had
    // nothing to work out returns nothing here.
    ...(value.discovered === undefined ? {} : { discovered: value.discovered })
  };
}

/**
 * Preparing a whole space's materials, so no later download pays for the looking.
 *
 * Answers as soon as the agent has accepted the list. Progress and findings are read back with
 * `readTeamRestitchPreparation` — the run outlives the request on purpose, so a reload does not
 * abandon minutes of work.
 */
export async function prepareTeamRestitchMaterials(input: {
  operationId: string;
  teamId: string;
  transferUrl: string;
  materials: {
    materialId: string;
    driveVersion: string;
    fileName: string;
    transferGrant: TeamTransferGrant;
  }[];
  audio?: { sampleRate: number; channels: number } | null;
}): Promise<{ accepted: true }> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  const contracts = health.toolContracts ?? {};
  if (!toolContractCompatible('teamWorkspace', contracts) || !toolContractCompatible('stitcher', contracts)) {
    throw new Error('AGENT_UPDATE_REQUIRED');
  }
  const value = await requestBody<{ accepted?: unknown }>('/api/team/restitch/prepare', {
    operationId: input.operationId,
    teamId: input.teamId,
    transferUrl: input.transferUrl,
    materials: input.materials,
    ...(input.audio ? { audio: input.audio } : {})
  });
  if (value.accepted !== true) throw new Error('INVALID_RESPONSE');
  return { accepted: true };
}

export interface TeamRestitchPreparationReport {
  state: 'running' | 'finished' | 'canceled';
  done: number;
  total: number;
  current: string | null;
  findings: {
    materialId: string;
    state: 'inspecting' | 'prepared' | 'unsupported' | 'failed';
    prep: MaterialRestitchPrep | null;
    reason: string | null;
  }[];
}

/** What a preparation run has found so far; `null` when the agent has never heard of it. */
export async function readTeamRestitchPreparation(
  operationId: string
): Promise<TeamRestitchPreparationReport | null> {
  let value: Record<string, unknown>;
  try {
    value = await request<Record<string, unknown>>(
      `/api/team/restitch/prepare/${encodeURIComponent(operationId)}`,
      'GET'
    );
  } catch {
    // A run the agent has forgotten, or an agent that is no longer there: the page stops
    // waiting rather than treating it as a failure of the materials.
    return null;
  }
  const state = value.state;
  if (
    (state !== 'running' && state !== 'finished' && state !== 'canceled') ||
    typeof value.done !== 'number' ||
    typeof value.total !== 'number' ||
    !Array.isArray(value.findings)
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  const findings: TeamRestitchPreparationReport['findings'] = [];
  for (const entry of value.findings) {
    if (typeof entry !== 'object' || entry === null) continue;
    const finding = entry as Record<string, unknown>;
    const reported = finding.state;
    if (
      typeof finding.materialId !== 'string' ||
      (reported !== 'inspecting' &&
        reported !== 'prepared' &&
        reported !== 'unsupported' &&
        reported !== 'failed')
    ) {
      continue;
    }
    const prep = parseMaterialRestitchPrep(finding.prep);
    findings.push({
      materialId: finding.materialId,
      state: reported,
      // An unreadable record is reported as no record: the material simply stays unprepared,
      // which is slower and always correct.
      prep: prep.ok ? prep.value : null,
      reason: typeof finding.reason === 'string' ? finding.reason : null
    });
  }
  return {
    state,
    done: value.done,
    total: value.total,
    current: typeof value.current === 'string' ? value.current : null,
    findings
  };
}

export async function cancelTeamRestitchPreparation(operationId: string): Promise<boolean> {
  const value = await requestBody<{ canceled?: unknown }>(
    `/api/team/restitch/prepare/${encodeURIComponent(operationId)}/cancel`,
    {}
  );
  return value.canceled === true;
}

/**
 * Can the agent on this machine re-stitch at all?
 *
 * Asked before the choice is offered, so an agent that predates the tool says so instead of
 * failing halfway through a download. This is the *live* contract from `/api/health` — nothing
 * here touches `WEB_TOOL_REQUIREMENTS`, which is compared byte-for-byte with the signed
 * manifest and therefore cannot gain an entry until the release that ships the agent.
 */
export async function agentCanRestitch(): Promise<boolean> {
  try {
    const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
    const contracts = health.toolContracts ?? {};
    return (
      toolContractCompatible('teamWorkspace', contracts) &&
      toolContractCompatible('stitcher', contracts)
    );
  } catch {
    // No agent, or one that cannot answer: the caller offers the original instead.
    return false;
  }
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

/**
 * Asks the local app for a poster frame of a video Drive has no thumbnail for.
 *
 * Resolves false when this build cannot make one — the tile then keeps the kind
 * glyph, which is where it was before. The grant is the one minted for reading
 * the file; the agent hands the picture straight to the cloud with it.
 */
export async function requestTeamPosterFrame(input: {
  materialId: string;
  grant: TeamTransferGrant;
}): Promise<boolean> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!teamPosterFrameSupported(health.toolContracts ?? {})) return false;
  try {
    const value = await requestBody<{ stored?: unknown }>('/api/team/poster', {
      ...input,
      transferUrl: teamTransferRangeUrl(),
      // The picture goes back to the transfer function, which owns the cache
      // the whole interface already reads.
      cloudBaseUrl: teamTransferRangeUrl().replace(/\/range$/u, '')
    });
    return value.stored === true;
  } catch {
    // A video whose first second will not decode, a file that vanished, an
    // agent that went away: none of them is worth surfacing over a picture.
    return false;
  }
}

/** Stops a download the app is running, transfer and local work together. */
export async function cancelTeamDownload(operationId: string): Promise<boolean> {
  const value = await requestBody<{ canceled?: unknown }>(
    `/api/team/download/${encodeURIComponent(operationId)}/cancel`,
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

/**
 * Holds the local half of a running team operation, or lets it go again.
 *
 * Resolves false when this build of the local app cannot hold anything — an
 * older agent, a transfer rather than an encode, a moment between two children.
 * The caller keeps its queue paused either way; what changes is only what it
 * can honestly say about the file already in flight.
 */
export async function pauseTeamAgentProcess(
  operationId: string,
  paused: boolean
): Promise<boolean> {
  const health = await request<Partial<HealthResponse>>('/api/health', 'GET');
  if (!teamProcessPauseSupported(health.toolContracts ?? {})) return false;
  try {
    const value = await requestBody<{ paused?: unknown }>(
      `/api/team/process/${encodeURIComponent(operationId)}/pause`,
      { paused }
    );
    return value.paused === paused;
  } catch {
    // NOT_PAUSABLE (409) and a vanished operation (404) are both answers, not
    // failures: the queue's own pause stands regardless.
    return false;
  }
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
export async function uploadForm<T>(url: string, body: FormData): Promise<T> {
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
/**
 * URL for the local, range-capable source media, carrying a capability ticket.
 *
 * The player seeks, which means range requests, which means the URL is used
 * repeatedly and stays in the element for as long as the modal is open — the
 * worst possible place for a session token.
 */
export function transcriptionMediaUrl(id: string): Promise<string | null> {
  return ticketedUrl(transcriptionMediaPath(id));
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
