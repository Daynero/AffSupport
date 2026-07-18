import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  clampCrf,
  clampFrameRate,
  clampResolutionLimit,
  clampVideoBitrateKbps,
  encodingFromSettings,
  type AgentSettings,
  type CompressionJob,
  type EncodingSettings,
  type QueueBatch
} from '@video-compressor/shared';

export interface PersistedState {
  jobs: CompressionJob[];
  settings: AgentSettings;
  batch: QueueBatch | null;
}

export const defaultSettings: AgentSettings = {
  mode: 'optimal',
  outputMode: 'next-to-originals',
  outputFolder: null,
  frameRate: null,
  resolutionLimit: null,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: DEFAULT_VIDEO_BITRATE_KBPS
};

export function defaultStatePath() {
  return (
    process.env.AGENT_STATE_PATH ??
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Local Video Compressor',
      'state.json'
    )
  );
}

export async function loadState(file = defaultStatePath()): Promise<PersistedState> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const settings = migrateSettings(data.settings);
    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const jobs = (
      await Promise.all(
        rawJobs.map(async value => {
          const job = migrateJob(value, settings);
          if (!job) return null;
          const pathToCheck = job.status === 'completed' ? job.outputPath : job.inputPath;
          try {
            await access(pathToCheck);
            return job;
          } catch {
            return null;
          }
        })
      )
    ).filter((job): job is CompressionJob => Boolean(job));

    const rawBatch = data.batch as Partial<QueueBatch> | null | undefined;
    const batch =
      rawBatch && typeof rawBatch.id === 'string' && Array.isArray(rawBatch.jobIds)
        ? {
            id: rawBatch.id,
            jobIds: rawBatch.jobIds.filter(
              (id): id is string => typeof id === 'string' && jobs.some(job => job.id === id)
            ),
            startedAt: Number(rawBatch.startedAt) || Date.now(),
            finishedAt: Number(rawBatch.finishedAt) || Date.now()
          }
        : null;
    return { jobs, settings, batch };
  } catch {
    return { jobs: [], settings: { ...defaultSettings }, batch: null };
  }
}

export async function saveState(state: PersistedState, file = defaultStatePath()) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, file);
}

function migrateSettings(value: unknown): AgentSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const legacyPreset = raw.preset;
  const mode =
    raw.mode === 'custom' || raw.mode === 'optimal'
      ? raw.mode
      : legacyPreset === 'quality'
        ? 'custom'
        : 'optimal';
  const outputMode = raw.outputMode === 'chosen-folder' ? 'chosen-folder' : 'next-to-originals';
  const frameRate =
    raw.frameRate === null || raw.frameRate === undefined
      ? null
      : clampFrameRate(raw.frameRate);
  const legacyKeepResolution = raw.keepResolution;
  const resolutionLimit =
    raw.resolutionLimit === null ||
    raw.resolutionLimit === undefined ||
    (legacyKeepResolution !== undefined && legacyKeepResolution !== false)
      ? null
      : clampResolutionLimit(raw.resolutionLimit);
  const hasLegacyBitrate = Number(raw.videoBitrateKbps) > 0;
  const rateControl = raw.rateControl === 'bitrate' || hasLegacyBitrate ? 'bitrate' : 'crf';
  return {
    mode,
    outputMode,
    outputFolder: typeof raw.outputFolder === 'string' && raw.outputFolder ? raw.outputFolder : null,
    frameRate,
    resolutionLimit,
    rateControl,
    crf: raw.crf === undefined ? DEFAULT_CRF : clampCrf(raw.crf),
    videoBitrateKbps: clampVideoBitrateKbps(raw.videoBitrateKbps)
  };
}

function migrateJob(value: unknown, settings: AgentSettings): CompressionJob | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.inputPath !== 'string' ||
    typeof raw.outputPath !== 'string' ||
    typeof raw.fileName !== 'string'
  ) {
    return null;
  }
  const legacyStatus = typeof raw.status === 'string' ? raw.status : 'ready';
  const status =
    legacyStatus === 'processing'
      ? 'interrupted'
      : legacyStatus === 'queued'
        ? 'ready'
        : legacyStatus === 'analyzing' ||
            legacyStatus === 'ready' ||
            legacyStatus === 'completed' ||
            legacyStatus === 'failed' ||
            legacyStatus === 'cancelled' ||
            legacyStatus === 'interrupted'
          ? legacyStatus
          : 'ready';
  const encoding = isEncoding(raw.encoding)
    ? normalizeEncoding(raw.encoding)
    : encodingFromSettings(settings);
  const numberOrNull = (input: unknown) => {
    if (input === null || input === undefined || input === '') return null;
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  return {
    id: raw.id,
    inputPath: raw.inputPath,
    outputPath: raw.outputPath,
    fileName: raw.fileName,
    sourceKind: raw.sourceKind === 'uploaded' ? 'uploaded' : 'local',
    sourceKey: typeof raw.sourceKey === 'string' ? raw.sourceKey : null,
    durationSeconds: numberOrNull(raw.durationSeconds),
    originalSize: Math.max(0, numberOrNull(raw.originalSize) ?? 0),
    sourceWidth: numberOrNull(raw.sourceWidth),
    sourceHeight: numberOrNull(raw.sourceHeight),
    sourceFrameRate: numberOrNull(raw.sourceFrameRate),
    sourceBitrate: numberOrNull(raw.sourceBitrate),
    sourceCodec: typeof raw.sourceCodec === 'string' ? raw.sourceCodec : null,
    finalSize: numberOrNull(raw.finalSize),
    finalWidth: numberOrNull(raw.finalWidth),
    finalHeight: numberOrNull(raw.finalHeight),
    finalFrameRate: numberOrNull(raw.finalFrameRate),
    finalBitrate: numberOrNull(raw.finalBitrate),
    finalDurationSeconds: numberOrNull(raw.finalDurationSeconds),
    finalCodec: typeof raw.finalCodec === 'string' ? raw.finalCodec : null,
    progress: numberOrNull(raw.progress),
    status,
    error:
      status === 'interrupted'
        ? 'Compression was interrupted when the agent stopped.'
        : typeof raw.error === 'string'
          ? raw.error
          : null,
    errorDetails: typeof raw.errorDetails === 'string' ? raw.errorDetails : null,
    encoding,
    batchId: null,
    startedAt: numberOrNull(raw.startedAt),
    finishedAt: status === 'interrupted' ? Date.now() : numberOrNull(raw.finishedAt),
    estimateStatus:
      status === 'completed'
        ? 'cancelled'
        : raw.estimateStatus === 'estimated' ||
            raw.estimateStatus === 'waiting' ||
            raw.estimateStatus === 'unavailable' ||
            raw.estimateStatus === 'cancelled'
          ? raw.estimateStatus
          : 'waiting',
    estimatedOutputBytes: numberOrNull(raw.estimatedOutputBytes),
    estimatedSavingPercent: numberOrNull(raw.estimatedSavingPercent),
    estimateRangeMinBytes: numberOrNull(raw.estimateRangeMinBytes),
    estimateRangeMaxBytes: numberOrNull(raw.estimateRangeMaxBytes),
    estimateProgress: null,
    estimateError: typeof raw.estimateError === 'string' ? raw.estimateError : null,
    estimateKey: typeof raw.estimateKey === 'string' ? raw.estimateKey : null,
    estimatePriorityOrder: null
  };
}

function isEncoding(value: unknown): value is EncodingSettings {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<EncodingSettings>;
  return (
    (raw.mode === 'optimal' || raw.mode === 'custom') &&
    (raw.rateControl === 'crf' || raw.rateControl === 'bitrate')
  );
}

function normalizeEncoding(value: EncodingSettings): EncodingSettings {
  if (value.mode === 'optimal') return encodingFromSettings({ ...defaultSettings });
  return {
    mode: 'custom',
    frameRate: value.frameRate === null ? null : clampFrameRate(value.frameRate),
    resolutionLimit:
      value.resolutionLimit === null ? null : clampResolutionLimit(value.resolutionLimit),
    rateControl: value.rateControl,
    crf: clampCrf(value.crf),
    videoBitrateKbps:
      value.rateControl === 'bitrate' ? clampVideoBitrateKbps(value.videoBitrateKbps) : null
  };
}
