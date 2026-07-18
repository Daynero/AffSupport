import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_FRAME_RATE, clampCrf, clampFrameRate, clampVideoBitrateKbps, type AgentSettings, type CompressionJob } from '@video-compressor/shared';
export interface PersistedState { jobs: CompressionJob[]; settings: AgentSettings }
export const defaultSettings: AgentSettings = { preset: 'balanced', outputMode: 'next-to-originals', outputFolder: null, frameRate: DEFAULT_FRAME_RATE, videoBitrateKbps: null, keepResolution: true };
export function defaultStatePath() { return path.join(os.homedir(), 'Library', 'Application Support', 'Local Video Compressor', 'state.json'); }
export async function loadState(file = defaultStatePath()): Promise<PersistedState> {
  try { const data = JSON.parse(await readFile(file, 'utf8')) as PersistedState; return { settings: { ...defaultSettings, ...data.settings, frameRate: clampFrameRate(data.settings?.frameRate ?? DEFAULT_FRAME_RATE), crf: data.settings?.crf === undefined ? undefined : clampCrf(data.settings.crf), videoBitrateKbps: clampVideoBitrateKbps(data.settings?.videoBitrateKbps), keepResolution: data.settings?.keepResolution !== false }, jobs: (data.jobs ?? []).map(j => ({ ...j, preset: j.preset ?? 'balanced', estimateStatus: j.status === 'completed' ? (j.estimateStatus ?? 'cancelled') : j.estimateStatus === 'estimating' ? 'waiting' : (j.estimateStatus ?? 'waiting'), estimateProgress: null, ...(j.status === 'processing' ? { status: 'interrupted' as const, error: 'Compression was interrupted when the agent stopped.' } : {}) })) }; }
  catch { return { jobs: [], settings: defaultSettings }; }
}
export async function saveState(state: PersistedState, file = defaultStatePath()) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8'); await rename(tmp, file); }
