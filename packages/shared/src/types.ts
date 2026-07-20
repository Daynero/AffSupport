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
  RELEASE_CHANNEL,
  RELEASE_DOWNLOAD_URL,
  RELEASE_TAG
} from './release.js';

export {
  compareProductVersions,
  normalizeToolContracts,
  toolContractCompatible,
  WEB_TOOL_REQUIREMENTS
} from './release.js';
export type {
  ReleaseArtifact,
  ReleasePlatform,
  StableReleaseManifest,
  ToolContractName,
  ToolContracts,
  WishlyToolId
} from './release.js';

export const FRAME_RATE_MIN = 1;
export const FRAME_RATE_MAX = 240;
export const DEFAULT_CUSTOM_FRAME_RATE = 30;
export const CRF_MIN = 16;
export const CRF_MAX = 35;
export const DEFAULT_CRF = 26;
export const VIDEO_BITRATE_MIN_KBPS = 100;
export const VIDEO_BITRATE_MAX_KBPS = 100_000;
export const DEFAULT_VIDEO_BITRATE_KBPS = 2_500;
export const RESOLUTION_MIN = 144;
export const RESOLUTION_MAX = 7680;
export const DEFAULT_CUSTOM_RESOLUTION = 1080;
export const DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 45 * 60;
export const MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 1;
export const MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS = 99 * 60 * 60 + 59 * 60 + 59;

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
  startImage: ImageAsset | null;
  endImage: ImageAsset | null;
  finalDurationMode: FinalImageDurationMode;
  customFinalDurationSeconds: number;
  fitMode: ImageFitMode;
}

export interface JobImageEmbedding {
  startImage: ImageAsset | null;
  endImage: ImageAsset | null;
  finalDurationMode: FinalImageDurationMode;
  /** A random duration is null while a ready job is only being estimated, then frozen at queue start. */
  finalDurationSeconds: number | null;
  fitMode: ImageFitMode;
}

export interface EstimateBreakdown {
  dynamicVideoBytesPerSecond: number;
  staticVideoBytesPerSecond: number;
  audioBytesPerSecond: number;
  uncertainty: number;
}

export interface EncodingSettings {
  mode: CompressionMode;
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
  Omit<ImageEmbeddingSettings, 'startImage' | 'endImage'>
>;
export type AgentSettingsPatch = Omit<Partial<AgentSettings>, 'imageEmbedding'> & {
  imageEmbedding?: ImageEmbeddingSettingsPatch;
};

export function defaultImageEmbeddingSettings(): ImageEmbeddingSettings {
  return {
    enabled: false,
    startImage: null,
    endImage: null,
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
    fitMode: 'cover'
  };
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
      frameRate: null,
      resolutionLimit: null,
      rateControl: 'crf',
      crf: DEFAULT_CRF,
      videoBitrateKbps: null
    };
  }

  return {
    mode: 'custom',
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
    settings.finalDurationMode,
    settings.finalDurationSeconds,
    settings.fitMode
  ]);
}

export function jobConfigurationKey(
  settings: EncodingSettings,
  imageEmbedding: JobImageEmbedding | null
): string {
  return JSON.stringify([encodingKey(settings), imageEmbeddingKey(imageEmbedding)]);
}

export function draftImageEmbedding(settings: ImageEmbeddingSettings): JobImageEmbedding | null {
  if (!settings.enabled || (!settings.startImage && !settings.endImage)) return null;
  return {
    startImage: settings.startImage ? { ...settings.startImage } : null,
    endImage: settings.endImage ? { ...settings.endImage } : null,
    finalDurationMode: settings.finalDurationMode,
    finalDurationSeconds:
      settings.endImage && settings.finalDurationMode === 'custom'
        ? settings.customFinalDurationSeconds
        : null,
    fitMode: settings.fitMode
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
}

/** Optional capabilities advertised by the local agent. */
export const AGENT_CAPABILITIES = ['landing', 'local-file-paths'] as const;
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
export type LandingJobStatus = 'preparing' | 'ready' | 'processing' | 'completed' | 'failed';

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
}

export interface LandingJob {
  id: string;
  name: string;
  sourceKind: LandingSourceKind;
  status: LandingJobStatus;
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
