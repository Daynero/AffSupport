import { LANGUAGE_CODES, isRecord, type TranscriptIngestState } from './contract.js';

/** Shared processing requirement, attempt, result, lease and sidecar contracts. */

export const LIBRARY_JOB_KINDS = ['transcription', 'translation', 'landing_optimization'] as const;
export type LibraryJobKind = (typeof LIBRARY_JOB_KINDS)[number];

export const LIBRARY_REQUIREMENT_STATES = [
  'pending',
  'leased',
  'running',
  'ready',
  'failed',
  'canceled',
  'stale',
  'skipped'
] as const;
export type LibraryRequirementState = (typeof LIBRARY_REQUIREMENT_STATES)[number];

export const LIBRARY_ATTEMPT_STATES = [
  'leased',
  'running',
  'ready',
  'failed',
  'canceled',
  'expired',
  'skipped'
] as const;
export type LibraryAttemptState = (typeof LIBRARY_ATTEMPT_STATES)[number];

export const LIBRARY_RESULT_STATES = ['current', 'stale', 'superseded'] as const;
export type LibraryResultState = (typeof LIBRARY_RESULT_STATES)[number];

export const LIBRARY_JOB_LEASE_SECONDS = 90;
export const LIBRARY_JOB_HEARTBEAT_SECONDS = 30;
export const LIBRARY_JOB_STAGE_MAX_LENGTH = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LANGUAGE_SET = new Set<string>(LANGUAGE_CODES);
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{24,2048}$/u;
const VARIANT = /^(?:original|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|[a-z0-9][a-z0-9._:-]{0,63})$/u;
const SAFE_STAGE = /^[a-z][a-z0-9_:-]{0,63}$/u;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isLibraryJobKind(value: unknown): value is LibraryJobKind {
  return typeof value === 'string' && (LIBRARY_JOB_KINDS as readonly string[]).includes(value);
}

export interface LibraryRequirementIdentity {
  teamId: string;
  sourceMaterialId: string;
  sourceVersion: string;
  kind: LibraryJobKind;
  variant: string;
}

export function parseLibraryRequirementIdentity(value: unknown): LibraryRequirementIdentity | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['teamId', 'sourceMaterialId', 'sourceVersion', 'kind', 'variant']) ||
    !isUuid(value.teamId) ||
    !isUuid(value.sourceMaterialId) ||
    typeof value.sourceVersion !== 'string' ||
    value.sourceVersion.length < 1 ||
    value.sourceVersion.length > 256 ||
    !isLibraryJobKind(value.kind) ||
    typeof value.variant !== 'string' ||
    !VARIANT.test(value.variant)
  ) {
    return null;
  }
  if (value.kind === 'transcription' && value.variant !== 'original') return null;
  if (value.kind !== 'transcription' && value.variant === 'original') return null;
  return {
    teamId: value.teamId,
    sourceMaterialId: value.sourceMaterialId,
    sourceVersion: value.sourceVersion,
    kind: value.kind,
    variant: value.variant
  };
}

export interface LibraryJobClaimRequest {
  teamId: string;
  agentInstanceId: string;
  supportedKinds: LibraryJobKind[];
  interfaceLanguage: string;
  sourceMaterialId?: string;
}

export function parseLibraryJobClaim(value: unknown): LibraryJobClaimRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'agentInstanceId',
      'supportedKinds',
      'interfaceLanguage',
      'sourceMaterialId'
    ]) ||
    !isUuid(value.teamId) ||
    !isUuid(value.agentInstanceId) ||
    !Array.isArray(value.supportedKinds) ||
    value.supportedKinds.length < 1 ||
    value.supportedKinds.length > LIBRARY_JOB_KINDS.length ||
    typeof value.interfaceLanguage !== 'string' ||
    !LANGUAGE_SET.has(value.interfaceLanguage) ||
    (value.sourceMaterialId !== undefined && !isUuid(value.sourceMaterialId))
  ) {
    return null;
  }
  const supportedKinds: LibraryJobKind[] = [];
  const seen = new Set<LibraryJobKind>();
  for (const kind of value.supportedKinds) {
    if (!isLibraryJobKind(kind) || seen.has(kind)) return null;
    seen.add(kind);
    supportedKinds.push(kind);
  }
  return {
    teamId: value.teamId,
    agentInstanceId: value.agentInstanceId,
    supportedKinds,
    interfaceLanguage: value.interfaceLanguage,
    ...(typeof value.sourceMaterialId === 'string'
      ? { sourceMaterialId: value.sourceMaterialId }
      : {})
  };
}

export interface LibraryJobHeartbeatRequest {
  teamId: string;
  attemptId: string;
  agentInstanceId: string;
  leaseToken: string;
  progress: number;
  stage: string;
}

export function parseLibraryJobHeartbeat(value: unknown): LibraryJobHeartbeatRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'attemptId',
      'agentInstanceId',
      'leaseToken',
      'progress',
      'stage'
    ]) ||
    !isUuid(value.teamId) ||
    !isUuid(value.attemptId) ||
    !isUuid(value.agentInstanceId) ||
    typeof value.leaseToken !== 'string' ||
    !LEASE_TOKEN.test(value.leaseToken) ||
    typeof value.progress !== 'number' ||
    !Number.isInteger(value.progress) ||
    value.progress < 0 ||
    value.progress > 100 ||
    typeof value.stage !== 'string' ||
    !SAFE_STAGE.test(value.stage)
  ) {
    return null;
  }
  return {
    teamId: value.teamId,
    attemptId: value.attemptId,
    agentInstanceId: value.agentInstanceId,
    leaseToken: value.leaseToken,
    progress: value.progress,
    stage: value.stage
  };
}

export interface LibraryJobFinalizeRequest {
  teamId: string;
  attemptId: string;
  agentInstanceId: string;
  leaseToken: string;
  resultMaterialId: string;
  sourceVersion: string;
  idempotencyKey: string;
}

export function parseLibraryJobFinalize(value: unknown): LibraryJobFinalizeRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'attemptId',
      'agentInstanceId',
      'leaseToken',
      'resultMaterialId',
      'sourceVersion',
      'idempotencyKey'
    ]) ||
    !isUuid(value.teamId) ||
    !isUuid(value.attemptId) ||
    !isUuid(value.agentInstanceId) ||
    typeof value.leaseToken !== 'string' ||
    !LEASE_TOKEN.test(value.leaseToken) ||
    !isUuid(value.resultMaterialId) ||
    typeof value.sourceVersion !== 'string' ||
    value.sourceVersion.length < 1 ||
    value.sourceVersion.length > 256 ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/iu.test(value.idempotencyKey)
  ) {
    return null;
  }
  return {
    teamId: value.teamId,
    attemptId: value.attemptId,
    agentInstanceId: value.agentInstanceId,
    leaseToken: value.leaseToken,
    resultMaterialId: value.resultMaterialId,
    sourceVersion: value.sourceVersion,
    idempotencyKey: value.idempotencyKey
  };
}

export interface LibraryJobClaimResult extends LibraryRequirementIdentity {
  requirementId: string;
  attemptId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export type LibraryJobFinalizeResult =
  | { state: 'accepted'; resultId: string; materialId: string }
  | { state: 'skipped'; reason: 'already_completed'; materialId: string | null };

export type LibraryVideoTextKind = 'original' | 'translation';

export interface LibraryVideoTextVariant {
  materialId: string;
  kind: LibraryVideoTextKind;
  language: string;
  ingestState: TranscriptIngestState;
  truncated: boolean;
  text: string | null;
  updatedAt: string;
}

export interface LibraryVideoTextVariants {
  sourceVersion: string;
  variants: LibraryVideoTextVariant[];
  canProcess: boolean;
}

const TRANSCRIPT_STATES = new Set<TranscriptIngestState>([
  'not_applicable',
  'pending',
  'full',
  'truncated',
  'invalid_encoding',
  'unavailable'
]);

function parseVideoTextVariant(value: unknown): LibraryVideoTextVariant | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'materialId',
      'kind',
      'language',
      'ingestState',
      'truncated',
      'text',
      'updatedAt'
    ]) ||
    !isUuid(value.materialId) ||
    (value.kind !== 'original' && value.kind !== 'translation') ||
    typeof value.language !== 'string' ||
    (value.language !== 'unknown' && !LANGUAGE_SET.has(value.language)) ||
    typeof value.ingestState !== 'string' ||
    !TRANSCRIPT_STATES.has(value.ingestState as TranscriptIngestState) ||
    typeof value.truncated !== 'boolean' ||
    (value.text !== null && typeof value.text !== 'string') ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  return {
    materialId: value.materialId,
    kind: value.kind,
    language: value.language,
    ingestState: value.ingestState as TranscriptIngestState,
    truncated: value.truncated,
    text: value.text,
    updatedAt: value.updatedAt
  };
}

export function parseLibraryVideoTextVariants(value: unknown): LibraryVideoTextVariants | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['sourceVersion', 'variants', 'canProcess']) ||
    typeof value.sourceVersion !== 'string' ||
    value.sourceVersion.length < 1 ||
    value.sourceVersion.length > 256 ||
    !Array.isArray(value.variants) ||
    value.variants.length > 100 ||
    typeof value.canProcess !== 'boolean'
  ) {
    return null;
  }
  const variants: LibraryVideoTextVariant[] = [];
  const identities = new Set<string>();
  for (const raw of value.variants) {
    const variant = parseVideoTextVariant(raw);
    if (!variant) return null;
    const identity = `${variant.kind}:${variant.language}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    variants.push(variant);
  }
  return { sourceVersion: value.sourceVersion, variants, canProcess: value.canProcess };
}

export function transcriptSidecarName(sourceName: string, sourceVersion: string): string {
  const normalized = sourceName.normalize('NFC').trim();
  const base = normalized.replace(/\.[^.]+$/u, '') || 'video';
  const forbidden = '\\/:*?"<>|';
  const safeBase = [...base]
    .map(character =>
      forbidden.includes(character) || (character.codePointAt(0) ?? 0) <= 0x1f ? '_' : character
    )
    .join('')
    .slice(0, 180);
  const versionSuffix = sourceVersion.replace(/[^a-z0-9]/giu, '').slice(0, 12) || 'current';
  return `${safeBase}.transcript.${versionSuffix}.txt`;
}

export function translationSidecarName(
  sourceName: string,
  sourceVersion: string,
  language: string
): string {
  const transcript = transcriptSidecarName(sourceName, sourceVersion);
  const safeLanguage = language.replace(/[^A-Za-z0-9-]/gu, '').slice(0, 35) || 'unknown';
  return transcript.replace(/\.txt$/u, `.${safeLanguage}.txt`);
}
