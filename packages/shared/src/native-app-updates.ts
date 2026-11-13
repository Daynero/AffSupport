import { compareProductVersions, isPinnedReleaseArtifact } from './release.js';

export const NATIVE_UPDATE_SCHEMA = 1;
export const NATIVE_UPDATE_LIMITS = {
  frameBytes: 262_144,
  commandBodyBytes: 4_096,
  maximumPreparationTimeoutMs: 24 * 60 * 60_000,
  manifestBytes: 262_144,
  canonicalPayloadBytes: 131_072,
  archiveBytes: 4 * 1024 ** 3,
  cacheEntries: 2,
  historyEntries: 32,
  requestTimeoutMs: 15_000,
  downloadTimeoutMs: 30 * 60_000,
  readinessTimeoutMs: 120_000,
  checkIntervalMs: 60 * 60_000,
  minimumFreeBytes: 512 * 1024 ** 2
} as const;

export const NATIVE_UPDATE_STAGES = [
  'idle',
  'offered',
  'preparing',
  'prepared',
  'consented',
  'draining',
  'drained',
  'install_committed',
  'replacement_started',
  'replacement_committed',
  'relaunch_requested',
  'target_started',
  'native_ready',
  'ui_visible',
  'deferred',
  'cancelled',
  'failed',
  'recovering',
  'unknown'
] as const;
export type NativeUpdateStage = (typeof NATIVE_UPDATE_STAGES)[number];
export const NATIVE_UPDATE_CODES = [
  'APP_UPDATE_UNSUPPORTED',
  'APP_UPDATE_NATIVE_UNAVAILABLE',
  'APP_UPDATE_INVALID',
  'APP_UPDATE_STALE_REVISION',
  'APP_UPDATE_BUSY',
  'APP_UPDATE_WRONG_STATE',
  'APP_UPDATE_MANIFEST_INVALID',
  'APP_UPDATE_CANDIDATE_CHANGED',
  'APP_UPDATE_WRONG_TARGET',
  'APP_UPDATE_DOWNLOAD_FAILED',
  'APP_UPDATE_DOWNLOAD_TIMEOUT',
  'APP_UPDATE_DIGEST_MISMATCH',
  'APP_UPDATE_DISK_FULL',
  'APP_UPDATE_UNSAFE_INSTALLATION',
  'APP_UPDATE_PERMISSION_DENIED',
  'APP_UPDATE_FLUSH_FAILED',
  'APP_UPDATE_INTERRUPTED',
  'APP_UPDATE_REPLACEMENT_UNKNOWN',
  'APP_UPDATE_INSTALL_FAILED',
  'APP_UPDATE_READINESS_TIMEOUT',
  'APP_UPDATE_IDENTITY_MISMATCH',
  'APP_UPDATE_UI_UNCONFIRMED',
  'APP_UPDATE_POWER_UNAVAILABLE'
] as const;
export type NativeUpdateCode = (typeof NATIVE_UPDATE_CODES)[number];
export type NativeUpdateTarget = 'macos-arm64' | 'macos-x64';
export type NativeUpdateAction =
  'check' | 'prepare' | 'accept' | 'defer' | 'cancel' | 'ack-visible' | 'set-auto-download';
export interface NativeUpdateDescriptor {
  schemaVersion: 1;
  channel: 'stable' | 'beta';
  target: NativeUpdateTarget;
  version: string;
  buildNumber: string;
  buildId: string;
  sourceRevision: string;
  minimumSystemVersion: string;
  publisherTeamId: string;
  archive: { url: string; sha256: string; length: number; edSignature: string };
}
export interface NativeUpdateCommand {
  schemaVersion: 1;
  idempotencyKey: string;
  expectedRevision: number;
  candidateId: string | null;
  automaticDownload?: boolean;
}
export interface NativeUpdateSnapshot {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  operationId: string | null;
  attemptId: string | null;
  candidateId: string | null;
  candidate: NativeUpdateDescriptor | null;
  stage: NativeUpdateStage;
  lastProvenStage: NativeUpdateStage;
  code: NativeUpdateCode | null;
  downloadedBytes: number;
  totalBytes: number | null;
  nativeSuccess: boolean;
  uiSuccess: boolean;
  availableActions: NativeUpdateAction[];
  automaticDownload: boolean;
}

export function updateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isUpdateUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}
export function isNativeUpdateCode(value: unknown): value is NativeUpdateCode {
  return typeof value === 'string' && NATIVE_UPDATE_CODES.some(code => code === value);
}
export function nativeUpdateCandidateId(candidate: NativeUpdateDescriptor): string {
  return `${candidate.target}:${candidate.archive.sha256}`;
}
export function isNativeUpdateDescriptor(value: unknown): value is NativeUpdateDescriptor {
  if (!updateRecord(value) || !updateRecord(value.archive)) return false;
  const a = value.archive;
  if (value.schemaVersion !== 1 || !['macos-arm64', 'macos-x64'].includes(String(value.target)))
    return false;
  if (
    typeof value.version !== 'string' ||
    value.version.length > 64 ||
    compareProductVersions(value.version, value.version) !== 0
  )
    return false;
  if (typeof value.buildNumber !== 'string' || !/^\d{1,12}$/.test(value.buildNumber)) return false;
  if (value.buildId !== `${value.version}+${value.buildNumber}`) return false;
  if (typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(value.sourceRevision))
    return false;
  if (
    typeof value.minimumSystemVersion !== 'string' ||
    !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(value.minimumSystemVersion)
  )
    return false;
  if (typeof value.publisherTeamId !== 'string' || !/^[A-Z0-9]{10}$/.test(value.publisherTeamId))
    return false;
  if (!['stable', 'beta'].includes(String(value.channel))) return false;
  let pinned = isPinnedReleaseArtifact(a);
  if (
    value.channel === 'beta' &&
    typeof a.url === 'string' &&
    typeof a.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(a.sha256)
  ) {
    try {
      const url = new URL(a.url);
      pinned =
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.href === a.url;
    } catch {
      return false;
    }
  }
  if (
    !pinned ||
    !Number.isSafeInteger(a.length) ||
    Number(a.length) < 1 ||
    Number(a.length) > NATIVE_UPDATE_LIMITS.archiveBytes
  )
    return false;
  if (typeof a.edSignature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(a.edSignature))
    return false;
  const arch = value.target === 'macos-arm64' ? 'arm64' : 'x64';
  return (
    typeof a.url === 'string' &&
    a.url.endsWith(`/v${value.version}/Soty-v${value.version}-macOS-${arch}.zip`)
  );
}
export function nativeUpdateMatchesManifest(
  candidate: NativeUpdateDescriptor,
  manifest: { version: string; buildId: string; buildNumber: string; channel?: string }
): boolean {
  return (
    candidate.channel === (manifest.channel ?? 'stable') &&
    candidate.version === manifest.version &&
    candidate.buildId === manifest.buildId &&
    candidate.buildNumber === manifest.buildNumber
  );
}
export function isNativeUpdateCommand(value: unknown): value is NativeUpdateCommand {
  if (
    !updateRecord(value) ||
    (value.automaticDownload !== undefined && typeof value.automaticDownload !== 'boolean') ||
    Object.keys(value).some(
      key =>
        ![
          'schemaVersion',
          'idempotencyKey',
          'expectedRevision',
          'candidateId',
          'automaticDownload'
        ].includes(key)
    )
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    isUpdateUuid(value.idempotencyKey) &&
    Number.isSafeInteger(value.expectedRevision) &&
    Number(value.expectedRevision) >= 0 &&
    (value.candidateId === null ||
      (typeof value.candidateId === 'string' &&
        /^macos-(?:arm64|x64):[0-9a-f]{64}$/.test(value.candidateId)))
  );
}
export function isNativeUpdateSnapshot(value: unknown): value is NativeUpdateSnapshot {
  if (!updateRecord(value) || value.schemaVersion !== 1 || !isUpdateUuid(value.installationId))
    return false;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false;
  if (![value.operationId, value.attemptId].every(id => id === null || isUpdateUuid(id)))
    return false;
  if (value.candidate !== null && !isNativeUpdateDescriptor(value.candidate)) return false;
  if (value.candidateId !== (value.candidate ? nativeUpdateCandidateId(value.candidate) : null))
    return false;
  if (
    !NATIVE_UPDATE_STAGES.some(stage => stage === value.stage) ||
    !NATIVE_UPDATE_STAGES.some(stage => stage === value.lastProvenStage)
  )
    return false;
  if (value.code !== null && !isNativeUpdateCode(value.code)) return false;
  if (
    !Number.isSafeInteger(value.downloadedBytes) ||
    Number(value.downloadedBytes) < 0 ||
    Number(value.downloadedBytes) > NATIVE_UPDATE_LIMITS.archiveBytes
  )
    return false;
  if (
    value.totalBytes !== null &&
    (!Number.isSafeInteger(value.totalBytes) ||
      Number(value.totalBytes) < Number(value.downloadedBytes) ||
      Number(value.totalBytes) > NATIVE_UPDATE_LIMITS.archiveBytes)
  )
    return false;
  if (
    typeof value.nativeSuccess !== 'boolean' ||
    typeof value.uiSuccess !== 'boolean' ||
    (value.uiSuccess && !value.nativeSuccess)
  )
    return false;
  return (
    typeof value.automaticDownload === 'boolean' &&
    Array.isArray(value.availableActions) &&
    value.availableActions.every(action =>
      [
        'check',
        'prepare',
        'accept',
        'defer',
        'cancel',
        'ack-visible',
        'set-auto-download'
      ].includes(action)
    )
  );
}
