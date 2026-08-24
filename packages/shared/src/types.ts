export type JobStatus =
  | 'analyzing'
  | 'ready'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type CompressionMode = 'optimal' | 'custom';
export type RateControl = 'crf' | 'bitrate';
export type OutputMode = 'next-to-originals' | 'chosen-folder';
export type EstimateStatus = 'waiting' | 'estimating' | 'estimated' | 'unavailable' | 'cancelled';
export type SourceKind = 'local' | 'uploaded';
export type ImageSlot = 'start' | 'end';
export type ImageFitMode = 'cover' | 'contain' | 'stretch';
export type FinalImageDurationMode = 'random-30-40' | 'random-40-50' | 'random-50-60' | 'custom';
/** How long the embedded start image is held: one full frame, a fixed short preset, or a custom value. */
export type StartImageDurationMode = 'one-frame' | 'ms-2' | 'ms-5' | 'ms-10' | 'custom';
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ProcessingStage = 'preparing-images' | 'compressing' | 'finalizing';

export {
  AGENT_API_VERSION,
  AGENT_TOOL_CONTRACTS,
  AGENT_PRODUCT_NAME,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  HELP_URL,
  CORE_CONTRACT_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_ARTIFACT_NAME,
  RELEASE_ARTIFACT_NAME_WINDOWS,
  RELEASE_CHANNEL,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_TAG
} from './release.js';

export {
  compareProductVersions,
  normalizeToolContracts,
  powerThrottleSupported,
  releaseManifestSigningPayload,
  toolContractCompatible,
  MIN_POWER_CONTRACT,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  WEB_TOOL_REQUIREMENTS
} from './release.js';
export type {
  ReleaseArtifact,
  ReleasePlatform,
  ReleaseSummaryLanguage,
  StableReleaseManifest,
  ToolContractName,
  ToolContracts,
  SotyToolId
} from './release.js';

export * from './team/index.js';
export {
  APP_ENVIRONMENTS,
  appEnvironmentOrProduction,
  isLoopbackOrigin,
  isProductionEndpoint,
  parseAppEnvironment
} from './environment-runtime.js';
export type { AppEnvironment, ParsedAppEnvironment } from './environment-runtime.js';
export * from './environment.js';
export * from './lifecycle.js';

export const FRAME_RATE_MIN = 1;
export const FRAME_RATE_MAX = 240;
export const DEFAULT_CUSTOM_FRAME_RATE = 30;
export const CRF_MIN = 16;
export const CRF_MAX = 35;
export const DEFAULT_CRF = 26;
export const OPTIMAL_FRAME_RATE = 30;
export const OPTIMAL_RESOLUTION_LIMIT = 720;
export const VIDEO_BITRATE_MIN_KBPS = 100;
export const VIDEO_BITRATE_MAX_KBPS = 100_000;
export const DEFAULT_VIDEO_BITRATE_KBPS = 2_500;
export const RESOLUTION_MIN = 144;
export const RESOLUTION_MAX = 7680;
export const DEFAULT_CUSTOM_RESOLUTION = 1080;
export const DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 45 * 60;
export const MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 1;
export const MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 99 * 60 * 60 + 59 * 60 + 59;
export const DEFAULT_CUSTOM_START_IMAGE_DURATION_MS = 100;
export const MIN_CUSTOM_START_IMAGE_DURATION_MS = 1;
export const MAX_CUSTOM_START_IMAGE_DURATION_MS = 60_000;

/** Fixed durations (ms) for the non-custom short presets of the start image. */
const START_IMAGE_DURATION_PRESET_MS: Record<'ms-2' | 'ms-5' | 'ms-10', number> = {
  'ms-2': 2,
  'ms-5': 5,
  'ms-10': 10
};

export interface ImageAsset {
  id: string;
  fileName: string;
  width: number;
  height: number;
  size: number;
  mimeType: ImageMimeType;
  extension: '.png' | '.jpg' | '.webp';
}

export interface ImageEmbeddingSettings {
  enabled: boolean;
  startImages: ImageAsset[];
  endImages: ImageAsset[];
  replaceExisting: boolean;
  finalDurationMode: FinalImageDurationMode;
  customFinalDurationSeconds: number;
  startDurationMode: StartImageDurationMode;
  customStartDurationMs: number;
  fitMode: ImageFitMode;
}

export interface JobImageEmbedding {
  startImage: ImageAsset | null;
  endImage: ImageAsset | null;
  startDurationMode: StartImageDurationMode;
  customStartDurationMs: number;
  finalDurationMode: FinalImageDurationMode;
  /** A random duration is null while a ready job is only being estimated, then frozen at queue start. */
  finalDurationSeconds: number | null;
  fitMode: ImageFitMode;
  replaceExisting: boolean;
  /** Seconds removed from the source edges before the new images are embedded. */
  sourceTrimStartSeconds: number;
  sourceTrimEndSeconds: number;
}

export interface EstimateBreakdown {
  dynamicVideoBytesPerSecond: number;
  staticVideoBytesPerSecond: number;
  audioBytesPerSecond: number;
  uncertainty: number;
}

export interface EncodingSettings {
  mode: CompressionMode;
  stripMetadata: boolean;
  frameRate: number | null;
  resolutionLimit: number | null;
  rateControl: RateControl;
  crf: number;
  videoBitrateKbps: number | null;
}

export interface AgentSettings {
  mode: CompressionMode;
  outputMode: OutputMode;
  outputFolder: string | null;
  stripMetadata: boolean;
  frameRate: number | null;
  resolutionLimit: number | null;
  rateControl: RateControl;
  crf: number;
  videoBitrateKbps: number;
  imageEmbedding: ImageEmbeddingSettings;
}

/**
 * Browser-writable settings. Image assets are deliberately excluded because
 * they can only be changed through the managed image upload/delete endpoints.
 */
export type ImageEmbeddingSettingsPatch = Partial<
  Omit<ImageEmbeddingSettings, 'startImages' | 'endImages'>
>;
export type AgentSettingsPatch = Omit<Partial<AgentSettings>, 'imageEmbedding'> & {
  imageEmbedding?: ImageEmbeddingSettingsPatch;
};

export function defaultImageEmbeddingSettings(): ImageEmbeddingSettings {
  return {
    enabled: false,
    startImages: [],
    endImages: [],
    replaceExisting: false,
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
    startDurationMode: 'one-frame',
    customStartDurationMs: DEFAULT_CUSTOM_START_IMAGE_DURATION_MS,
    fitMode: 'cover'
  };
}

export function clampCustomStartDurationMs(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number)
    ? Math.min(
        MAX_CUSTOM_START_IMAGE_DURATION_MS,
        Math.max(MIN_CUSTOM_START_IMAGE_DURATION_MS, number)
      )
    : DEFAULT_CUSTOM_START_IMAGE_DURATION_MS;
}

/** Resolves the embedded start image hold time (seconds) for the chosen mode and frame rate. */
export function startImageDurationSeconds(
  settings: Pick<JobImageEmbedding, 'startDurationMode' | 'customStartDurationMs'>,
  frameRate: number
): number {
  if (settings.startDurationMode === 'custom') {
    return clampCustomStartDurationMs(settings.customStartDurationMs) / 1000;
  }
  const preset =
    START_IMAGE_DURATION_PRESET_MS[settings.startDurationMode as 'ms-2' | 'ms-5' | 'ms-10'];
  // `one-frame` (and any legacy/absent mode) holds the image for exactly one video frame.
  return preset !== undefined ? preset / 1000 : 1 / frameRate;
}

export function clampFrameRate(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number)
    ? Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, number))
    : DEFAULT_CUSTOM_FRAME_RATE;
}

export function clampCrf(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(CRF_MAX, Math.max(CRF_MIN, number)) : DEFAULT_CRF;
}

export function clampVideoBitrateKbps(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number)
    ? Math.min(VIDEO_BITRATE_MAX_KBPS, Math.max(VIDEO_BITRATE_MIN_KBPS, number))
    : DEFAULT_VIDEO_BITRATE_KBPS;
}

export function clampResolutionLimit(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number)
    ? Math.min(RESOLUTION_MAX, Math.max(RESOLUTION_MIN, number))
    : DEFAULT_CUSTOM_RESOLUTION;
}

export function encodingFromSettings(settings: AgentSettings): EncodingSettings {
  if (settings.mode === 'optimal') {
    return {
      mode: 'optimal',
      stripMetadata: settings.stripMetadata,
      frameRate: OPTIMAL_FRAME_RATE,
      resolutionLimit: OPTIMAL_RESOLUTION_LIMIT,
      rateControl: 'crf',
      crf: DEFAULT_CRF,
      videoBitrateKbps: null
    };
  }

  return {
    mode: 'custom',
    stripMetadata: settings.stripMetadata,
    frameRate: settings.frameRate,
    resolutionLimit: settings.resolutionLimit,
    rateControl: settings.rateControl,
    crf: settings.crf,
    videoBitrateKbps: settings.rateControl === 'bitrate' ? settings.videoBitrateKbps : null
  };
}

export function encodingKey(settings: EncodingSettings): string {
  return JSON.stringify([
    settings.mode,
    settings.stripMetadata,
    settings.frameRate,
    settings.resolutionLimit,
    settings.rateControl,
    settings.crf,
    settings.videoBitrateKbps
  ]);
}

export function imageEmbeddingKey(settings: JobImageEmbedding | null): string {
  if (!settings) return 'none';
  return JSON.stringify([
    settings.startImage?.id ?? null,
    settings.endImage?.id ?? null,
    settings.startDurationMode,
    settings.customStartDurationMs,
    settings.finalDurationMode,
    settings.finalDurationSeconds,
    settings.fitMode,
    settings.replaceExisting,
    settings.sourceTrimStartSeconds,
    settings.sourceTrimEndSeconds
  ]);
}

export function jobConfigurationKey(
  settings: EncodingSettings,
  imageEmbedding: JobImageEmbedding | null
): string {
  return JSON.stringify([encodingKey(settings), imageEmbeddingKey(imageEmbedding)]);
}

export function draftImageEmbedding(settings: ImageEmbeddingSettings): JobImageEmbedding | null {
  const startImage = settings.startImages[0] ?? null;
  const endImage = settings.endImages[0] ?? null;
  if (!settings.enabled || (!startImage && !endImage)) return null;
  return {
    startImage: startImage ? { ...startImage } : null,
    endImage: endImage ? { ...endImage } : null,
    startDurationMode: settings.startDurationMode,
    customStartDurationMs: settings.customStartDurationMs,
    finalDurationMode: settings.finalDurationMode,
    finalDurationSeconds:
      endImage && settings.finalDurationMode === 'custom'
        ? settings.customFinalDurationSeconds
        : null,
    fitMode: settings.fitMode,
    replaceExisting: settings.replaceExisting,
    sourceTrimStartSeconds: 0,
    sourceTrimEndSeconds: 0
  };
}

export function finalImageDurationRange(
  mode: Exclude<FinalImageDurationMode, 'custom'>
): readonly [number, number] {
  if (mode === 'random-30-40') return [30 * 60, 40 * 60];
  if (mode === 'random-50-60') return [50 * 60, 60 * 60];
  return [40 * 60, 50 * 60];
}

export function randomFinalImageDurationSeconds(
  mode: Exclude<FinalImageDurationMode, 'custom'>,
  random = Math.random
): number {
  const [minimum, maximum] = finalImageDurationRange(mode);
  return (
    minimum + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (maximum - minimum + 1))
  );
}

export function estimatedFinalImageDurationSeconds(settings: JobImageEmbedding | null): number {
  if (!settings?.endImage) return 0;
  if (settings.finalDurationSeconds !== null) return settings.finalDurationSeconds;
  if (settings.finalDurationMode === 'custom') return 0;
  const [minimum, maximum] = finalImageDurationRange(settings.finalDurationMode);
  return Math.round((minimum + maximum) / 2);
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function expectedDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
  resolutionLimit: number | null
): { width: number; height: number } | null {
  if (!width || !height) return null;
  const longest = Math.max(width, height);
  if (!resolutionLimit || longest <= resolutionLimit) {
    return { width: evenFloor(width), height: evenFloor(height) };
  }
  const targetLongest = Math.max(2, Math.floor(resolutionLimit / 2) * 2);
  if (width >= height)
    return { width: targetLongest, height: even((height / width) * targetLongest) };
  return { width: even((width / height) * targetLongest), height: targetLongest };
}

export function expectedFrameRate(
  sourceFrameRate: number | null | undefined,
  requestedFrameRate: number | null
): number | null {
  return requestedFrameRate ?? sourceFrameRate ?? null;
}

export interface CompressionJob {
  id: string;
  inputPath: string;
  outputPath: string;
  fileName: string;
  sourceKind?: SourceKind;
  sourceKey?: string | null;
  durationSeconds: number | null;
  originalSize: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceFrameRate: number | null;
  sourceBitrate: number | null;
  sourceCodec: string | null;
  sourceHasAudio: boolean;
  sourceAudioBitrate: number | null;
  sourceAudioSampleRate: number | null;
  sourceAudioChannels: number | null;
  sourceAudioLayout: string | null;
  finalSize: number | null;
  finalWidth: number | null;
  finalHeight: number | null;
  finalFrameRate: number | null;
  finalBitrate: number | null;
  finalDurationSeconds: number | null;
  finalCodec: string | null;
  progress: number | null;
  processingStage: ProcessingStage | null;
  status: JobStatus;
  error: string | null;
  errorDetails: string | null;
  encoding: EncodingSettings;
  imageEmbedding: JobImageEmbedding | null;
  batchId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  estimateStatus: EstimateStatus;
  estimatedOutputBytes: number | null;
  estimatedSavingPercent: number | null;
  estimateRangeMinBytes: number | null;
  estimateRangeMaxBytes: number | null;
  estimateProgress: { completed: number; total: number } | null;
  estimateError: string | null;
  estimateKey: string | null;
  /** FIFO position for an estimate requested while the compression queue is running. */
  estimatePriorityOrder: number | null;
  estimateBreakdown: EstimateBreakdown | null;
}

export interface QueueBatch {
  id: string;
  jobIds: string[];
  startedAt: number;
  finishedAt: number | null;
}

export interface QueueState {
  /**
   * Monotonic within one local-app run, incremented on every broadcast.
   *
   * A snapshot can arrive after a newer one: a request in flight when an event
   * fires resolves second and overwrites it, and the interface then shows a job
   * as running that has already finished. Comparing revisions makes that
   * impossible to miss — the older snapshot is simply dropped.
   *
   * **Resets to zero when the local app restarts**, so a client must key its
   * reset on the reported instance identity rather than treating a lower number
   * as stale; otherwise the first snapshot after a restart is rejected forever.
   * Optional because an older agent omits it: absent normalises to zero and the
   * guard degrades to the behaviour that existed before it.
   */
  revision?: number;
  jobs: CompressionJob[];
  running: boolean;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  settings: AgentSettings;
  batch: QueueBatch | null;
  warning: string | null;
  update?: {
    state: 'none' | 'pending' | 'draining';
    targetBuildId: string | null;
  };
  /**
   * Conversions started from the native file manager.
   *
   * They ride the compressor's stream rather than opening an eighth channel (FR-009b):
   * a conversion is work the machine is doing, and the connection budget is the reason
   * this release exists. Absent on agents built before this release, and on any agent
   * whose platform does not offer the file-manager bridge.
   */
  mediaActions?: MediaActionState;
}

export type AgentEventType =
  | 'state'
  | 'estimate:queued'
  | 'estimate:started'
  | 'estimate:progress'
  | 'estimate:completed'
  | 'estimate:failed'
  | 'estimate:cancelled';
export type AgentEvent = { type: AgentEventType; state: QueueState };

/**
 * Server-issued entitlement state reported by the agent. `enforced` is false
 * for development/unpackaged agents; when true, tool routes require a signed
 * entitlement token (with an offline grace window after the last accepted one).
 */
export interface AgentEntitlementStatus {
  enforced: boolean;
  entitled: boolean;
  reason: 'not-enforced' | 'active' | 'grace' | 'missing' | 'expired';
  graceUntil: string | null;
}

export interface HealthResponse {
  ok: boolean;
  tools: QueueState['tools'];
  version: string;
  buildNumber: string;
  buildId: string;
  apiVersion: number;
  channel: string;
  sourceRevision: string;
  /** Optional tool capabilities the agent supports, e.g. ['landing']. Absent on older agents. */
  capabilities?: string[];
  coreContractVersion?: number;
  toolContracts?: import('./release.js').ToolContracts;
  update?: QueueState['update'];
  /** Absent on agents older than the entitlement rollout. */
  entitlement?: AgentEntitlementStatus;
}

/**
 * Closed set of capabilities an agent may advertise. A given agent publishes a
 * *subset*: entries gated on what the host operating system can actually do are
 * omitted where it cannot (the agent derives its list from its platform layer),
 * so a Windows agent never claims a macOS-only mechanism. Clients must treat an
 * absent entry as "not offered" and an unknown entry as harmless.
 */
export const AGENT_CAPABILITIES = [
  /**
   * One connection carries every channel, instead of one connection per tool.
   *
   * Gated rather than assumed because the seven per-tool endpoints are not removed in this
   * release: a client that does not see this keeps using them, and neither side has to be
   * upgraded in step with the other.
   */
  'event-stream',
  'finder-image-conversion',
  'landing',
  'landing-preview',
  'local-file-paths',
  'native-file-picker',
  'team-workspace',
  'transcription'
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];
export interface SessionResponse {
  token: string;
}
export interface ErrorResponse {
  error: string;
}
export type SelectionIssue =
  'already-compressed' | 'duplicate' | 'unsupported-format' | 'inaccessible';
export interface SelectionWarning {
  id: string;
  fileName: string;
  reason: SelectionIssue;
  message: string;
}
export interface SelectionResponse {
  state: QueueState;
  warnings: SelectionWarning[];
}

export interface QueueSummary {
  successful: number;
  failed: number;
  originalSize: number;
  finalSize: number;
  savedBytes: number;
  savedPercent: number;
}

export function calculateQueueSummary(jobs: CompressionJob[]): QueueSummary {
  const completed = jobs.filter(job => job.status === 'completed' && job.finalSize !== null);
  const originalSize = completed.reduce((total, job) => total + job.originalSize, 0);
  const finalSize = completed.reduce((total, job) => total + (job.finalSize ?? 0), 0);
  const savedBytes = Math.max(0, originalSize - finalSize);
  return {
    successful: completed.length,
    failed: jobs.filter(job => job.status === 'failed').length,
    originalSize,
    finalSize,
    savedBytes,
    savedPercent: originalSize ? Math.max(0, Math.round((savedBytes / originalSize) * 100)) : 0
  };
}

/* -------------------------------------------------------------------------- */
/* Landing Optimizer                                                          */
/*                                                                            */
/* A separate tool that optimizes a whole landing page (a ZIP or a folder):   */
/* it converts raster images to WebP, re-encodes videos with the proven video */
/* pipeline, rewrites every local asset reference, and returns a fully working */
/* optimized copy. It shares the local agent, pairing, and design system with  */
/* the Video Compressor but keeps its own state so the two never interfere.   */
/* -------------------------------------------------------------------------- */

export type LandingImageQuality = 'optimal' | 'high';
export type LandingVideoQuality = 'optimal' | 'high';
export type LandingSourceKind = 'zip' | 'folder';
export type LandingAssetType = 'image' | 'video';
export type LandingAssetStatus = 'pending' | 'processing' | 'optimized' | 'skipped' | 'failed';
export type LandingJobStatus =
  'preparing' | 'ready' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type LandingJobPhase =
  | 'preparing'
  | 'ready'
  | 'queued'
  | 'optimizing'
  | 'rewriting'
  | 'packaging'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The three parts of `processing`, and the only thing a landing job's phase adds to its
 * status.
 *
 * Six of the nine phases are just the status spelled again. Keeping them independently
 * assignable meant nine more states for the lifecycle to cover and six more ways for the two
 * to disagree — and they did: a job could report `phase: 'optimizing'` while its status said
 * `cancelled`, because the two were written at different points in the same teardown.
 */
export type LandingStep = 'optimizing' | 'rewriting' | 'packaging';

/**
 * The phase a job in this status and step is in.
 *
 * `phase` stays on the wire exactly as it was — this is not a contract change. What changes
 * is that it is derived rather than assigned, so it cannot drift from the status it is
 * supposed to describe.
 */
export function phaseOf(status: LandingJobStatus, step: LandingStep | null): LandingJobPhase {
  // Only `processing` has sub-steps; every other status names its own phase. A step recorded
  // against a finished job is stale bookkeeping, not a phase, and is ignored here rather
  // than allowed to outrank the status.
  if (status === 'processing') return step ?? 'optimizing';
  return status;
}

/** High Quality re-encode: keep resolution and frame rate, compress gently. */
export const LANDING_HIGH_QUALITY_CRF = 20;

export interface LandingSettings {
  imageQuality: LandingImageQuality;
  videoQuality: LandingVideoQuality;
  /** When true the result is a `<name>-optimized.zip`, otherwise a folder. */
  archive: boolean;
}

export interface LandingAsset {
  id: string;
  /** POSIX path of the asset relative to the landing root. */
  relPath: string;
  fileName: string;
  type: LandingAssetType;
  status: LandingAssetStatus;
  originalSize: number;
  optimizedSize: number | null;
  savedBytes: number | null;
  savedPercent: number | null;
  /** 0–100 while a video is being re-encoded, otherwise null. */
  progress: number | null;
  /** New relative path when the extension changed (e.g. `.jpg` → `.webp`). */
  newRelPath: string | null;
  /** A short, localizable reason a file was skipped or failed. */
  note: string | null;
  /** Local-only before/after content is available through the paired agent. */
  preview: {
    available: boolean;
    /** False when the original was kept and only a single preview is available. */
    comparison: boolean;
    width: number | null;
    height: number | null;
  } | null;
}

export interface LandingJob {
  id: string;
  name: string;
  sourceKind: LandingSourceKind;
  status: LandingJobStatus;
  /** The current end-to-end phase, including work after media encoding. */
  phase: LandingJobPhase;
  /** Authoritative, monotonic job progress. Null while preparation is indeterminate. */
  progress: number | null;
  completedAssets: number;
  totalAssets: number;
  currentAssetId: string | null;
  settings: LandingSettings;
  assets: LandingAsset[];
  imagesOptimized: number;
  videosOptimized: number;
  filesSkipped: number;
  filesFailed: number;
  referencesUpdated: number;
  originalMediaSize: number;
  optimizedMediaSize: number;
  savedBytes: number;
  savedPercent: number;
  outputPath: string | null;
  outputIsArchive: boolean;
  error: string | null;
  warnings: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LandingState {
  /**
   * Monotonic within one local-app run, incremented on every broadcast.
   *
   * A snapshot can arrive after a newer one: a request in flight when an event
   * fires resolves second and overwrites it, and the interface then shows a job
   * as running that has already finished. Comparing revisions makes that
   * impossible to miss — the older snapshot is simply dropped.
   *
   * **Resets to zero when the local app restarts**, so a client must key its
   * reset on the reported instance identity rather than treating a lower number
   * as stale; otherwise the first snapshot after a restart is rejected forever.
   * Optional because an older agent omits it: absent normalises to zero and the
   * guard degrades to the behaviour that existed before it.
   */
  revision?: number;
  /** Every landing currently prepared, queued, processing, or completed. */
  jobs: LandingJob[];
  /** Most recently added landing, retained for compatibility with older clients. */
  job: LandingJob | null;
  settings: LandingSettings;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  running: boolean;
}

export type LandingEventType = 'landing:state' | 'landing:progress';
export interface LandingEvent {
  type: LandingEventType;
  state: LandingState;
}

export function defaultLandingSettings(): LandingSettings {
  return { imageQuality: 'optimal', videoQuality: 'optimal', archive: false };
}

export interface LandingSummary {
  imagesOptimized: number;
  videosOptimized: number;
  filesSkipped: number;
  filesFailed: number;
  originalMediaSize: number;
  optimizedMediaSize: number;
  savedBytes: number;
  savedPercent: number;
}

export function calculateLandingSummary(assets: LandingAsset[]): LandingSummary {
  let imagesOptimized = 0;
  let videosOptimized = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  let originalMediaSize = 0;
  let optimizedMediaSize = 0;
  for (const asset of assets) {
    originalMediaSize += asset.originalSize;
    if (asset.status === 'optimized') {
      if (asset.type === 'image') imagesOptimized += 1;
      else videosOptimized += 1;
      optimizedMediaSize += asset.optimizedSize ?? asset.originalSize;
    } else {
      if (asset.status === 'skipped') filesSkipped += 1;
      else if (asset.status === 'failed') filesFailed += 1;
      // A skipped or failed asset keeps its original bytes in the output.
      optimizedMediaSize += asset.originalSize;
    }
  }
  const savedBytes = Math.max(0, originalMediaSize - optimizedMediaSize);
  return {
    imagesOptimized,
    videosOptimized,
    filesSkipped,
    filesFailed,
    originalMediaSize,
    optimizedMediaSize,
    savedBytes,
    savedPercent: originalMediaSize
      ? Math.max(0, Math.round((savedBytes / originalMediaSize) * 100))
      : 0
  };
}

/* -------------------------------------------------------------------------- */
/* Landing Preview                                                            */
/*                                                                            */
/* A persistent, local catalogue of full-page landing screenshots. A source  */
/* catalogue is a user-selected folder (including a Google Drive for desktop  */
/* mount); individual landings may be folders or one/many roots inside ZIPs.  */
/* -------------------------------------------------------------------------- */

export type LandingPreviewSourceKind = 'folder' | 'zip' | 'team';
/**
 * A conversion started from the native file manager.
 *
 * `skipped` means the output already existed; `cancelled` means the user stopped it. They
 * shared one state until A3, which made a stop indistinguishable from a no-op in the list.
 *
 * Lives here rather than beside the queue because the interface has to render it, and a
 * status the two processes describe separately is a status they will eventually disagree on.
 */
export type MediaActionStatus =
  'queued' | 'processing' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export const IMAGE_CONVERSION_FORMATS = ['png', 'jpeg', 'webp'] as const;
export type ImageConversionFormat = (typeof IMAGE_CONVERSION_FORMATS)[number];

/** One conversion in the media-action list. */
export interface MediaActionJob {
  id: string;
  kind: 'image-conversion';
  inputPath: string;
  /** Where the result will be written; null until a destination is chosen, and for a skip. */
  outputPath: string | null;
  targetFormat: ImageConversionFormat;
  status: MediaActionStatus;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * Session-scoped: nothing here survives a restart, deliberately. Persisting it would be
 * new capability rather than the hardening this release is.
 */
export interface MediaActionState {
  running: boolean;
  jobs: MediaActionJob[];
}

export type LandingPreviewItemStatus = 'queued' | 'rendering' | 'ready' | 'failed';
export type LandingPreviewPhase =
  | 'idle'
  | 'scanning'
  | 'downloading'
  | 'inspecting'
  | 'extracting'
  | 'rendering'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface LandingPreviewItem {
  id: string;
  name: string;
  /** POSIX path used to place this leaf in the UI tree. */
  relativePath: string;
  sourceKind: LandingPreviewSourceKind;
  /** Folder or ZIP path relative to the selected catalogue root. */
  sourceRelativePath: string;
  /** Landing root inside a ZIP, or null for folder sources / archive root. */
  archiveRoot: string | null;
  /** A safe cached extraction exists and can be opened locally. */
  extractedAvailable: boolean;
  status: LandingPreviewItemStatus;
  /** The source changed after the last successful preview. */
  stale: boolean;
  previewAvailable: boolean;
  previewWidth: number | null;
  previewHeight: number | null;
  /** Number of seamless full-resolution image slices that form this preview. */
  previewSegments?: number;
  renderedAt: number | null;
  blockedExternalRequests: number;
  warning: string | null;
  error: string | null;
}

export interface LandingPreviewCatalogSummary {
  id: string;
  name: string;
  landingCount: number;
  lastOpenedAt: number;
  sourceAvailable: boolean;
  /** Team snapshots are downloaded through scoped render grants; local catalogues use folders. */
  sourceKind?: 'local' | 'team';
  teamId?: string;
}

export type TeamLandingPreviewSnapshotState =
  'ready' | 'candidate' | 'rendering' | 'needs_agent' | 'agent_outdated' | 'error';

/** Short-lived, browser-authorized snapshot imported into the standalone local previewer. */
export interface TeamLandingPreviewSnapshotItem {
  materialId: string;
  name: string;
  state: TeamLandingPreviewSnapshotState;
  sourceVersion: string;
  fingerprint: string;
  preset: string;
  previewUrls: string[];
  failureReason?: string;
}

export interface TeamLandingPreviewCatalogRequest {
  teamId: string;
  teamName: string;
  items: TeamLandingPreviewSnapshotItem[];
}

export interface LandingPreviewProgress {
  phase: LandingPreviewPhase;
  completed: number;
  total: number;
  currentLandingId: string | null;
}

export type LandingPreviewDevice = 'desktop' | 'tablet' | 'mobile';
export type LandingPreviewColorScheme = 'light' | 'dark';

/** Render options that change the captured image, so they key the preview cache. */
export interface LandingPreviewRenderSettings {
  device: LandingPreviewDevice;
  colorScheme: LandingPreviewColorScheme;
}

export interface LandingPreviewState {
  catalogs: LandingPreviewCatalogSummary[];
  activeCatalogId: string | null;
  activeCatalogName: string | null;
  landings: LandingPreviewItem[];
  running: boolean;
  progress: LandingPreviewProgress;
  renderer: { available: boolean; error: string | null };
  settings: LandingPreviewRenderSettings;
  /** Non-fatal inaccessible/corrupt entries skipped during the last scan. */
  warnings: string[];
  error: string | null;
  updatedAt: number | null;
}

export type LandingPreviewEventType = 'landing-preview:state' | 'landing-preview:progress';
export interface LandingPreviewEvent {
  type: LandingPreviewEventType;
  state: LandingPreviewState;
}

/* -------------------------------------------------------------------------- */
/* Transcription                                                              */
/*                                                                            */
/* A separate local tool that turns speech in audio/video files into plain   */
/* text. It runs whisper.cpp with a bundled multilingual model, detects the  */
/* spoken language automatically (99 languages), and never leaves the         */
/* machine. Like the Landing Optimizer it shares the agent, pairing, and      */
/* design system with the Video Compressor but keeps its own state.           */
/* -------------------------------------------------------------------------- */

/**
 * The same eight states as a compression.
 *
 * `interrupted` closes A12: a run cut short by a restart used to be recorded as `failed`
 * here and as `interrupted` in the compressor, so one tool told the user their work had
 * broken and the other told them it had been interrupted. Existing persisted records are
 * left alone — only new interruptions use it.
 */
export type TranscriptionJobStatus =
  | 'analyzing'
  | 'ready'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** File extensions the transcriber accepts (audio + video containers). */
export const TRANSCRIBE_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.aiff',
  '.aif'
] as const;

export function isTranscribableFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return TRANSCRIBE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Curated language override list for the UI. `auto` is the default and covers
 * every language the model supports through automatic detection — the rest are
 * common explicit choices for when a file is misdetected.
 */
export const TRANSCRIPTION_LANGUAGE_CODES = [
  'auto',
  'uk',
  'en',
  'ru',
  'pl',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'tr',
  'cs',
  'ro',
  'sk',
  'bg',
  'sv',
  'da',
  'no',
  'fi',
  'el',
  'he',
  'ar',
  'fa',
  'hi',
  'ja',
  'ko',
  'zh',
  'vi',
  'id',
  'th'
] as const;

export type TranscriptionLanguageCode = (typeof TRANSCRIPTION_LANGUAGE_CODES)[number];

/**
 * Target languages covered by TranslateGemma's published WMT24++ evaluation.
 * Base BCP-47 tags are used in the UI; the model's embedded chat template also
 * accepts regional variants. English is included because it is the pivot/source
 * language for the published benchmark and a required fallback target.
 */
export const TRANSLATEGEMMA_LANGUAGE_CODES = [
  'en',
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'is',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'nl',
  'no',
  'pa',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
  'zh-TW',
  'zu'
] as const;

/** Permissive BCP-47-ish validation against TranslateGemma's target languages. */
export function isValidTargetLanguage(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(code.trim())) {
    return false;
  }
  const normalized = code.trim().replaceAll('_', '-');
  const base = normalized.split('-')[0].toLowerCase();
  return TRANSLATEGEMMA_LANGUAGE_CODES.some(
    supported => supported.toLowerCase() === normalized.toLowerCase() || supported === base
  );
}

export function normalizeTargetLanguage(code: string): string {
  const normalized = code.trim().replaceAll('_', '-');
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? normalized;
  } catch {
    return normalized;
  }
}

/**
 * Single source of truth for picking a translation target from a source
 * language and the preferred (UI) language. Both the agent's automatic
 * translation and the web viewer's default MUST resolve through this function
 * — if they disagree, opening the detail view supersedes and restarts the
 * translation the list already started.
 *
 * Returns null when the source is unknown (`auto`) or the preferred language
 * is not a valid TranslateGemma target. Translating into the source language
 * is avoided via `lastDistinctTarget` (an earlier explicit pick), then the
 * opposite built-in Soty language.
 */
export function resolveTranslationTarget(
  sourceLanguage: string,
  preferredLanguage: string,
  lastDistinctTarget: string | null = null
): string | null {
  const source = sourceLanguage.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase();
  if (!source || source === 'auto' || !isValidTargetLanguage(preferredLanguage)) return null;
  const preferred = normalizeTargetLanguage(preferredLanguage);
  if (preferred.split('-')[0]?.toLowerCase() !== source) return preferred;
  const previous = lastDistinctTarget?.trim();
  if (previous && isValidTargetLanguage(previous)) {
    const normalizedPrevious = normalizeTargetLanguage(previous);
    if (normalizedPrevious.split('-')[0]?.toLowerCase() !== source) return normalizedPrevious;
  }
  const fallback = source === 'en' ? 'uk' : 'en';
  return isValidTargetLanguage(fallback) ? normalizeTargetLanguage(fallback) : null;
}

export interface TranscriptionSettings {
  /** `auto` detects the spoken language; otherwise an ISO 639-1 code. */
  language: string;
  /** Preferred automatic translation target (normally the Soty UI language). */
  translationLanguage: string;
}

/**
 * Lightweight translation state carried in the live queue. The translated
 * text stays in the private sidecar and is fetched only on demand.
 */
export interface TranscriptionTranslationSummary {
  /** Currently selected target language for this job. */
  targetLanguage: string;
  status: TranslationStatus | 'unavailable';
  /** 0–100 for determinate work, null while a queued task has not started. */
  progress: number | null;
  completedSegments: number;
  totalSegments: number;
  /**
   * Wall-clock ms when inference first started, or null before that. Lets any
   * surface (list or detail) compute the same continuous elapsed/ETA instead of
   * restarting a local timer when it mounts.
   */
  startedAt?: number | null;
  /** Stable UI-safe error code; never raw transcript or runtime diagnostics. */
  error: 'TRANSLATION_FAILED' | 'TRANSLATION_CANCELLED' | 'TRANSLATOR_UNAVAILABLE' | null;
}

export interface TranscriptionJob {
  id: string;
  inputPath: string;
  fileName: string;
  sourceKind: SourceKind;
  sourceKey: string | null;
  durationSeconds: number | null;
  status: TranscriptionJobStatus;
  /** 0–100 while transcribing, null when indeterminate. */
  progress: number | null;
  /** Language requested when the job started (`auto` or an ISO code). */
  requestedLanguage: string;
  /** Language Whisper actually used, once known. */
  detectedLanguage: string | null;
  /** Full plain-text transcript once completed. */
  text: string | null;
  /** Transcript length in characters, for quick UI hints. */
  characters: number | null;
  /**
   * Small status for the selected/automatic translation. Optional keeps the
   * web client compatible with queue snapshots produced before this field.
   */
  translation?: TranscriptionTranslationSummary | null;
  error: string | null;
  errorDetails: string | null;
  batchId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TranscriptionTools {
  /** ffmpeg is required to extract a normalized audio track. */
  ffmpeg: boolean;
  /** The bundled whisper.cpp binary is present and runnable. */
  whisper: boolean;
  /** The speech model file is present (bundled or downloaded). */
  model: boolean;
}

/** First-run download state for the local speech model. */
export interface TranscriptionModelInfo {
  /** The model file exists and is ready to use. */
  present: boolean;
  /** A download is currently in progress. */
  downloading: boolean;
  /** 0–100 while downloading, null otherwise. */
  progress: number | null;
  /** Total download size in bytes (for the confirmation prompt). */
  sizeBytes: number;
  /** Bytes fetched so far in the current download. */
  downloadedBytes: number;
  /**
   * Opaque id shared by every artifact started from the same confirmation.
   * It lets clients keep completed bytes in the weighted aggregate while a
   * slower sibling artifact is still downloading, without counting models
   * that were already installed before the confirmation.
   */
  downloadBatchId?: string | null;
  /** Human-facing model label, e.g. "large-v3". */
  label: string;
  /** Last download error, cleared when a new download starts. */
  error: string | null;
}

export interface TranscriptionState {
  /**
   * Monotonic within one local-app run, incremented on every broadcast.
   *
   * A snapshot can arrive after a newer one: a request in flight when an event
   * fires resolves second and overwrites it, and the interface then shows a job
   * as running that has already finished. Comparing revisions makes that
   * impossible to miss — the older snapshot is simply dropped.
   *
   * **Resets to zero when the local app restarts**, so a client must key its
   * reset on the reported instance identity rather than treating a lower number
   * as stale; otherwise the first snapshot after a restart is rejected forever.
   * Optional because an older agent omits it: absent normalises to zero and the
   * guard degrades to the behaviour that existed before it.
   */
  revision?: number;
  jobs: TranscriptionJob[];
  running: boolean;
  tools: TranscriptionTools;
  model: TranscriptionModelInfo;
  /** First-run download state for the local translation model (TranslateGemma). */
  translatorModel: TranscriptionModelInfo;
  /** Raw pinned llama.cpp runtime state, exposed for install diagnostics. */
  translatorRuntime: TranscriptionModelInfo;
  /** Multilingual E5 model used for local semantic phrase alignment. */
  alignmentModel: TranscriptionModelInfo;
  settings: TranscriptionSettings;
}

export type TranscriptionEventType = 'transcription:state' | 'transcription:progress';

export interface TranscriptionEvent {
  type: TranscriptionEventType;
  state: TranscriptionState;
}

export function defaultTranscriptionSettings(): TranscriptionSettings {
  return { language: 'auto', translationLanguage: 'uk' };
}

/* -------------------------------------------------------------------------- */
/* Structured transcription document                                          */
/*                                                                            */
/* The flat `TranscriptionJob.text` stays as an in-process fallback.           */
/* Everything below is the richer private document used by the split-screen   */
/* viewer: per-word timestamps for karaoke playback and per-segment            */
/* translations with source↔target character alignments. No transcript file   */
/* is written beside the source media.                                         */
/* It is fetched on demand through dedicated endpoints, never streamed inside  */
/* `transcription:progress` SSE events, so the live queue state stays small.    */
/* -------------------------------------------------------------------------- */

/** A single decoded word, timestamped and anchored to its segment text. */
export interface TranscriptWord {
  /** Stable id, unique within the document (e.g. `<segmentId>-<index>`). */
  id: string;
  /** The word exactly as it appears in the segment's `sourceText`. */
  text: string;
  /** Absolute start/end in milliseconds from the beginning of the media. */
  startMs: number;
  endMs: number;
  /** Model confidence 0–1 when Whisper provides it, otherwise null. */
  confidence: number | null;
  /** Character offsets `[sourceStart, sourceEnd)` into `segment.sourceText`. */
  sourceStart: number;
  sourceEnd: number;
}

/** One sentence-ish segment of source speech with its words. */
export interface TranscriptSegment {
  id: string;
  /** Absolute start/end in milliseconds from the beginning of the media. */
  startMs: number;
  endMs: number;
  /** The segment text; word `sourceStart`/`sourceEnd` index into this. */
  sourceText: string;
  words: TranscriptWord[];
}

/** A source↔target character-span link inside one translated segment. */
export interface AlignmentLink {
  /** Char offsets into the source segment's `sourceText`. */
  sourceStart: number;
  sourceEnd: number;
  /** Char offsets into this segment's `translatedText`. */
  targetStart: number;
  targetEnd: number;
  /** Alignment confidence 0–1 (never a fabricated value — see the aligner). */
  confidence: number;
}

export interface TranslatedSegment {
  /** Ties back to `TranscriptSegment.id`. */
  sourceSegmentId: string;
  translatedText: string;
  alignments: AlignmentLink[];
}

export type TranslationStatus = 'queued' | 'processing' | 'completed' | 'failed';

/** All translations of a document into one target language. */
export interface TranslationDocument {
  /** Client generation id for correlating an in-flight language switch. */
  requestId?: string;
  /** BCP-47 / ISO code of the target language. */
  targetLanguage: string;
  /** Translator model version this was produced with (part of the cache key). */
  modelVersion: string;
  /** Exact source/language/model cache key; optional only for legacy sidecars. */
  cacheKey?: string;
  /** Alignment engine revision and whether phrase-level links were produced. */
  alignmentModelVersion?: string;
  alignmentStatus?: 'completed' | 'fallback';
  status: TranslationStatus;
  /** Total segments to translate; set while a translation is in flight. */
  totalSegments?: number;
  /** Segments translated so far; drives the determinate progress bar + ETA. */
  completedSegments?: number;
  /**
   * Source characters total/translated-so-far. Segments vary wildly in length,
   * so the progress bar and ETA are weighted by characters when available and
   * only fall back to the segment count for legacy sidecars.
   */
  totalCharacters?: number;
  completedCharacters?: number;
  /** Wall-clock ms when inference first started; survives preemption/resume so the ETA is continuous. */
  startedAt?: number | null;
  segments: TranslatedSegment[];
  /** Set when `status === 'failed'`; the last good translation is kept in the UI. */
  error: string | null;
}

/**
 * Optional, speech-derived pivot used only as the input to the text translator.
 * Whisper's direct speech→English task can preserve meaning better than asking
 * a small text model to interpret a noisy transcript in a distant language.
 * Entries stay keyed to the visible source segments so playback and alignment
 * continue to use the original-language transcript.
 */
export interface TranscriptionTranslationSource {
  language: string;
  modelVersion: string;
  segments: Array<{
    sourceSegmentId: string;
    text: string;
  }>;
}

/** The full structured sidecar for one transcription job. */
export interface TranscriptionDocument {
  jobId: string;
  /** Language of the source speech (detected or requested). */
  sourceLanguage: string;
  /** Transcriber (whisper) model version that produced the segments. */
  modelVersion: string;
  segments: TranscriptSegment[];
  /** Hidden speech-derived input for higher-quality translation when available. */
  translationSource?: TranscriptionTranslationSource;
  /** Keyed by target-language code. */
  translations: Record<string, TranslationDocument>;
}

export type TranscriptionMediaPreviewState = 'checking' | 'preparing' | 'ready' | 'failed';

/** Lightweight state for the local browser-compatible playback asset. */
export interface TranscriptionMediaPreview {
  state: TranscriptionMediaPreviewState;
  /** `original` streams the source; `proxy` streams a cached local MP4. */
  variant: 'original' | 'proxy' | null;
  progress: number | null;
  hasVideo: boolean | null;
  mimeType: string | null;
  error: string | null;
}

/**
 * Deterministic cache key for a translation. Two requests with the same source
 * content, source language, target language, and translator model version must
 * resolve to the same cached result — re-selecting an already-translated
 * language then resolves instantly. Order and separator are fixed so the key is
 * stable across processes.
 */
export function translationCacheKey(parts: {
  sourceContentHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatorModelVersion: string;
}): string {
  return [
    parts.sourceContentHash,
    parts.sourceLanguage,
    parts.targetLanguage,
    parts.translatorModelVersion
  ].join('\0');
}

/* ── Local Agent power throttle ─────────────────────────────────────────── */

/**
 * The user-facing ceiling on how much of the machine Soty's local tools may
 * use, as a share of total system CPU capacity. `POWER_LIMIT_MAX` means
 * unrestricted: at that setting the agent must behave exactly as it did before
 * the throttle existed — no thread arguments, no priority change, no signals.
 *
 * Nothing below `POWER_LIMIT_MIN` is offered because a smaller share risks
 * stalling work outright on a low-core machine.
 */
export const POWER_LIMIT_MIN = 20;
export const POWER_LIMIT_MAX = 100;
export const DEFAULT_POWER_LIMIT = POWER_LIMIT_MAX;

/**
 * The single authority for a valid limit. Every entry point — HTTP body,
 * persisted file, governor setter — goes through this, so the bounds live in
 * exactly one place. Anything that is not already a finite number yields the
 * default rather than throwing: the safe failure direction is "Soty runs at
 * full speed", never "Soty is mysteriously stuck at 20%".
 *
 * This deliberately does NOT use the loose `Number(value)` idiom the other
 * clamp helpers share. `Number(null)` is 0 and `Number('')` is 0, which that
 * idiom would clamp to the *minimum* — turning a missing value into the most
 * restrictive setting, the exact opposite of the safe direction.
 */
export function clampPowerLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POWER_LIMIT;
  return Math.min(POWER_LIMIT_MAX, Math.max(POWER_LIMIT_MIN, Math.round(value)));
}

export type PowerMode = 'unrestricted' | 'limited';
export type PowerActivity = 'idle' | 'active';

/** Why a consumption figure is missing, when one is. */
export type PowerSampleUnavailable = 'warming-up' | 'unsupported' | 'error';

/**
 * A consumption reading. Modelled as a discriminated union rather than a
 * nullable number so a caller cannot render "unavailable" as 0% — showing a
 * fabricated zero is exactly what the readout must never do.
 */
export type PowerSample =
  | {
      availability: 'ok';
      /** Soty's share of total system capacity, 0–100, one decimal. */
      systemSharePercent: number;
      activity: PowerActivity;
      cpuCount: number;
      sampledAt: string;
    }
  | {
      availability: PowerSampleUnavailable;
      activity: PowerActivity;
      cpuCount: number;
      sampledAt: string;
    };

/** Snapshot returned by both power routes and carried by every SSE frame. */
export interface PowerState {
  limitPercent: number;
  mode: PowerMode;
  sample: PowerSample;
  /** False when this host cannot throttle work that is already running. */
  throttlingSupported: boolean;
  activeChildren: number;
  updatedAt: string;
}

export type PowerEvent = PowerState;

export function powerModeFor(limitPercent: number): PowerMode {
  return limitPercent >= POWER_LIMIT_MAX ? 'unrestricted' : 'limited';
}

export interface PowerLimitRequest {
  limitPercent: number;
}

/**
 * Narrows an untrusted request body. A finite but out-of-range number is
 * accepted and clamped by the caller — a client sending 150 means "maximum",
 * and failing that request would be pedantic. Only a body that carries no
 * usable number at all is rejected.
 */
export function parsePowerLimitRequest(
  input: unknown
): { ok: true; value: PowerLimitRequest } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, error: 'POWER_LIMIT_INVALID' };
  const raw = (input as Record<string, unknown>).limitPercent;
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    return { ok: false, error: 'POWER_LIMIT_INVALID' };
  return { ok: true, value: { limitPercent: raw } };
}

/** On-disk shape of power.json. Read as `unknown` and parsed, never trusted. */
export interface PersistedPowerState {
  limitPercent: number;
  updatedAt: string;
}

export function parsePersistedPowerState(
  input: unknown
): { ok: true; value: PersistedPowerState } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, error: 'POWER_STATE_INVALID' };
  const record = input as Record<string, unknown>;
  if (typeof record.limitPercent !== 'number' || !Number.isFinite(record.limitPercent))
    return { ok: false, error: 'POWER_STATE_INVALID' };
  if (record.limitPercent < POWER_LIMIT_MIN || record.limitPercent > POWER_LIMIT_MAX)
    return { ok: false, error: 'POWER_STATE_OUT_OF_RANGE' };
  return {
    ok: true,
    value: {
      limitPercent: Math.round(record.limitPercent),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString()
    }
  };
}

/**
 * Whether an arriving snapshot should replace the one already shown.
 *
 * The whole rule in one place, so the thirty-odd writers cannot each get it
 * subtly different. Two cases are deliberately *not* stale: a snapshot from a
 * different local-app instance (a restart resets the counter, and rejecting it
 * would freeze the interface on the previous run's last state), and an equal
 * revision (a re-fetch of the same state is harmless and refusing it would make
 * a manual refresh do nothing).
 */
export function isNewerSnapshot(
  next: { revision?: number },
  current: { revision?: number } | null,
  options: { sameInstance?: boolean } = {}
): boolean {
  if (!current) return true;
  if (options.sameInstance === false) return true;
  return (next.revision ?? 0) >= (current.revision ?? 0);
}
