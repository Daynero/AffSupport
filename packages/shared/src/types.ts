export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type PresetId = 'quality' | 'balanced' | 'ultra-small';
export type OutputMode = 'next-to-originals' | 'chosen-folder';
export type EstimateStatus = 'waiting' | 'estimating' | 'estimated' | 'unavailable' | 'cancelled';
export const FRAME_RATE_MIN = 24, FRAME_RATE_MAX = 120, DEFAULT_FRAME_RATE = 120;
export function clampFrameRate(value: unknown): number { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, n)) : DEFAULT_FRAME_RATE; }
// frameRate caps the output frame rate (min with the preset's own cap and the source rate).
export interface AgentSettings { preset: PresetId; outputMode: OutputMode; outputFolder: string | null; frameRate?: number }

export interface CompressionJob {
  id: string;
  inputPath: string;
  outputPath: string;
  fileName: string;
  durationSeconds: number | null;
  originalSize: number;
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
