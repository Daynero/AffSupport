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

export const AGENT_API_VERSION = 3;

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

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function expectedDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
  resolutionLimit: number | null
): { width: number; height: number } | null {
  if (!width || !height) return null;
  const longest = Math.max(width, height);
  if (!resolutionLimit || longest <= resolutionLimit) return { width, height };
  const targetLongest = Math.max(2, Math.floor(resolutionLimit / 2) * 2);
  if (width >= height) return { width: targetLongest, height: even((height / width) * targetLongest) };
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
  finalSize: number | null;
  finalWidth: number | null;
  finalHeight: number | null;
  finalFrameRate: number | null;
  finalBitrate: number | null;
  finalDurationSeconds: number | null;
  finalCodec: string | null;
  progress: number | null;
  status: JobStatus;
  error: string | null;
  errorDetails: string | null;
  encoding: EncodingSettings;
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
}
export interface SessionResponse {
  token: string;
}
export interface ErrorResponse {
  error: string;
}
export type SelectionIssue = 'already-compressed' | 'duplicate' | 'unsupported-format' | 'inaccessible';
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
