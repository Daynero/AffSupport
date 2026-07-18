export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type PresetId = 'quality' | 'balanced' | 'ultra-small';
export type OutputMode = 'next-to-originals' | 'chosen-folder';
export type EstimateStatus = 'waiting' | 'estimating' | 'estimated' | 'unavailable' | 'cancelled';
export const FRAME_RATE_MIN = 24, FRAME_RATE_MAX = 120, DEFAULT_FRAME_RATE = 120;
export const CRF_MIN = 14, CRF_MAX = 34, DEFAULT_CRF = 24;
export const VIDEO_BITRATE_MIN_KBPS = 100, VIDEO_BITRATE_MAX_KBPS = 100_000;
export const RESOLUTION_MIN = 144, RESOLUTION_MAX = 7680, DEFAULT_RESOLUTION_LIMIT = 1920;
export function clampFrameRate(value: unknown): number { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, n)) : DEFAULT_FRAME_RATE; }
export function clampCrf(value: unknown): number { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(CRF_MAX, Math.max(CRF_MIN, n)) : DEFAULT_CRF; }
export function clampVideoBitrateKbps(value: unknown): number | null { if (value === null || value === undefined || value === '') return null; const n = Math.round(Number(value)); return Number.isFinite(n) && n > 0 ? Math.min(VIDEO_BITRATE_MAX_KBPS, Math.max(VIDEO_BITRATE_MIN_KBPS, n)) : null; }
export function clampResolutionLimit(value: unknown): number { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(RESOLUTION_MAX, Math.max(RESOLUTION_MIN, n)) : DEFAULT_RESOLUTION_LIMIT; }
// The Quality preset exposes manual controls: frameRate (fps cap), crf (quality target),
// videoBitrateKbps (optional average bitrate that overrides crf when set), and keepResolution
// (skip downscaling when true — the default). They are ignored by the Balanced/Ultra presets.
export interface AgentSettings { preset: PresetId; outputMode: OutputMode; outputFolder: string | null; frameRate?: number; crf?: number; videoBitrateKbps?: number | null; keepResolution?: boolean; resolutionLimit?: number }

export interface CompressionJob {
  id: string;
  inputPath: string;
  outputPath: string;
  fileName: string;
  durationSeconds: number | null;
  originalSize: number;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  sourceFrameRate?: number | null;
  sourceBitrate?: number | null;
  finalSize: number | null;
  progress: number | null;
  status: JobStatus;
  error: string | null;
  preset: PresetId;
  estimateStatus?: EstimateStatus;
  estimatedOutputBytes?: number | null;
  estimatedSavingPercent?: number | null;
  estimateRangeMinBytes?: number | null;
  estimateRangeMaxBytes?: number | null;
  estimateProgress?: { completed: number; total: number } | null;
  estimateError?: string | null;
  estimatePreset?: PresetId | null;
  /** FIFO position for an estimate requested while the compression queue is running. */
  estimatePriorityOrder?: number | null;
}

export interface QueueState {
  jobs: CompressionJob[];
  running: boolean;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  settings: AgentSettings;
  warning: string | null;
}

export type AgentEventType = 'state' | 'estimate:queued' | 'estimate:started' | 'estimate:progress' | 'estimate:completed' | 'estimate:failed' | 'estimate:cancelled';
export type AgentEvent = { type: AgentEventType; state: QueueState };
export interface HealthResponse { ok: boolean; tools: QueueState['tools']; version: string }
export interface SessionResponse { token: string }
export interface ErrorResponse { error: string }
export interface SelectionWarning { id: string; fileName: string; reason: 'already-compressed' | 'duplicate'; message: string }
export interface SelectionResponse { state: QueueState; warnings: SelectionWarning[] }
export interface QueueSummary { successful: number; failed: number; originalSize: number; finalSize: number; savedBytes: number; savedPercent: number }
export function calculateQueueSummary(jobs: CompressionJob[]): QueueSummary { const completed=jobs.filter(j=>j.status==='completed'&&j.finalSize!==null);const originalSize=completed.reduce((n,j)=>n+j.originalSize,0),finalSize=completed.reduce((n,j)=>n+(j.finalSize??0),0),savedBytes=Math.max(0,originalSize-finalSize);return{successful:completed.length,failed:jobs.filter(j=>j.status==='failed').length,originalSize,finalSize,savedBytes,savedPercent:originalSize?Math.max(0,Math.round(savedBytes/originalSize*100)):0}; }
