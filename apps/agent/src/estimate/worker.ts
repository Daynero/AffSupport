import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type AgentEventType, type CompressionJob, type PresetId } from '@video-compressor/shared';
import { buildEstimateArgs, type EncodeOptions } from '../ffmpeg/presets.js';
import { ffmpegPath, ffprobePath } from '../ffmpeg/tools.js';
import { EstimateCache, estimateCacheKey } from './cache.js';
import { createSamplePlan, estimateFromSamples } from './sampler.js';

type EstimatePatch = Partial<Pick<CompressionJob, 'estimateStatus' | 'estimatedOutputBytes' | 'estimatedSavingPercent' | 'estimateRangeMinBytes' | 'estimateRangeMaxBytes' | 'estimateProgress' | 'estimateError' | 'estimatePreset'>>;

export class EstimationWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private paused = false;
  private pumping = false;
  private generation = 0;
  private currentDone: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  constructor(private jobs: () => CompressionJob[], private update: (id: string, patch: EstimatePatch, event: AgentEventType) => void, private compressionRunning: () => boolean, private cache = new EstimateCache(), private options: () => EncodeOptions = () => ({})) {}
  async init() { await this.cache.load(); this.schedule(); }
  schedule(delay = 0) { if (this.debounce) clearTimeout(this.debounce); this.debounce = setTimeout(() => { this.debounce = null; void this.pump(); }, delay); }
  invalidateForPreset(preset: PresetId) { this.generation++; this.child?.kill('SIGTERM'); for (const job of this.jobs()) if (job.status !== 'completed') this.update(job.id, { estimateStatus: 'waiting', estimatedOutputBytes: null, estimatedSavingPercent: null, estimateRangeMinBytes: null, estimateRangeMaxBytes: null, estimateProgress: null, estimateError: null, estimatePreset: preset }, 'estimate:queued'); this.schedule(450); }
  async pause() { this.paused = true; this.generation++; const child = this.child; child?.kill('SIGTERM'); if (child) setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 2000).unref(); await this.currentDone; }
  resume() { this.paused = false; for (const job of this.jobs()) if (!['completed', 'processing'].includes(job.status) && job.estimateStatus === 'cancelled') this.update(job.id, { estimateStatus: 'waiting', estimateError: null }, 'estimate:queued'); this.schedule(); }
  async shutdown() { this.paused = true; this.child?.kill('SIGTERM'); await this.currentDone; }
  private async pump() {
    if (this.pumping || this.paused || this.compressionRunning()) return;
    this.pumping = true;
    try { while (!this.paused && !this.compressionRunning()) { const job = this.jobs().find(j => !['completed', 'processing'].includes(j.status) && j.estimateStatus === 'waiting'); if (!job) break; const run = this.estimate(job, this.generation); this.currentDone = run; await run; this.currentDone = null; } }
    finally { this.pumping = false; }
  }
  private async estimate(job: CompressionJob, generation: number) {
    let temp = '';
    try {
      const options = this.options(); const source = await stat(job.inputPath); const key = estimateCacheKey(job.inputPath, source.size, source.mtimeMs, job.preset, options); const cached = this.cache.get(key);
      if (cached) { this.update(job.id, { ...cached, estimateStatus: 'estimated', estimatePreset: job.preset, estimateProgress: null, estimateError: null }, 'estimate:completed'); return; }
      const metadata = await probe(job.inputPath); const plan = createSamplePlan(metadata.duration); if (!plan.length) throw new Error('Duration is unavailable.');
      this.update(job.id, { estimateStatus: 'estimating', estimatePreset: job.preset, estimateProgress: { completed: 0, total: plan.length }, estimateError: null }, 'estimate:started');
      temp = await mkdtemp(path.join(os.tmpdir(), 'local-video-estimate-')); const sizes: number[] = [], durations: number[] = [];
      for (let i = 0; i < plan.length; i++) {
        if (this.paused || generation !== this.generation || this.compressionRunning()) throw new Cancelled();
        const sample = plan[i], output = path.join(temp, `sample-${i}.h264`); const result = await this.runFfmpeg(buildEstimateArgs(job.inputPath, output, job.preset, sample.start, sample.duration, options));
        if (this.paused || generation !== this.generation || this.compressionRunning()) throw new Cancelled();
        if (result === 0) { sizes.push((await stat(output)).size); durations.push(sample.duration); }
        this.update(job.id, { estimateProgress: { completed: i + 1, total: plan.length } }, 'estimate:progress');
      }
      if (sizes.length < Math.max(1, Math.ceil(plan.length * .5))) throw new Error('Too few representative samples could be read.');
      const audio = !metadata.hasAudio ? 0 : job.preset === 'ultra-small' ? 48_000 : job.preset === 'balanced' ? 96_000 : metadata.audioBitrate;
      const estimate = estimateFromSamples(sizes, durations, metadata.duration, audio, job.originalSize); if (!estimate) throw new Error('Not enough sample data.');
      await this.cache.set(key, { ...estimate, createdAt: Date.now() }); this.update(job.id, { ...estimate, estimateStatus: 'estimated', estimatePreset: job.preset, estimateProgress: null, estimateError: null }, 'estimate:completed');
    } catch (error) {
      if (error instanceof Cancelled) this.update(job.id, { estimateStatus: this.paused ? 'cancelled' : 'waiting', estimateProgress: null, estimateError: null }, this.paused ? 'estimate:cancelled' : 'estimate:queued');
      else this.update(job.id, { estimateStatus: 'unavailable', estimateProgress: null, estimateError: error instanceof Error ? error.message : 'Estimate unavailable.' }, 'estimate:failed');
    } finally { this.child = null; if (temp) await rm(temp, { recursive: true, force: true }); }
  }
  private runFfmpeg(args: string[]) { return new Promise<number | null>(resolve => { const child = spawn(ffmpegPath, args, { shell: false }); this.child = child; child.on('error', () => resolve(null)); child.on('close', resolve); }); }
}
class Cancelled extends Error {}
function probe(input: string) { return new Promise<{ duration: number; audioBitrate: number; hasAudio: boolean }>((resolve, reject) => { const process = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,bit_rate', '-of', 'json', input], { shell: false }); let out = ''; process.stdout.on('data', d => { out += d; }); process.on('error', reject); process.on('close', code => { try { if (code !== 0) throw new Error(); const value = JSON.parse(out), duration = Number(value.format?.duration); if (!Number.isFinite(duration) || duration <= 0) throw new Error(); const audio = value.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'audio'); resolve({ duration, audioBitrate: Number(audio?.bit_rate) || 128_000, hasAudio: Boolean(audio) }); } catch { reject(new Error('FFprobe could not determine duration.')); } }); }); }
