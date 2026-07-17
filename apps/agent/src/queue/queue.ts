import { randomUUID } from 'node:crypto';
import { access, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { DEFAULT_FRAME_RATE, clampFrameRate, type AgentEventType, type AgentSettings, type CompressionJob, type QueueState, type SelectionWarning } from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure } from '../ffmpeg/encoder.js';
import { PRESETS } from '../ffmpeg/presets.js';
import { probeDuration } from '../ffmpeg/tools.js';
import { appearsCompressed, fileSize, nextOutputPath } from '../files/paths.js';

export class JobQueue {
  private active: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private warning: string | null = null;
  private estimateHooks: { schedule: () => void; invalidateForPreset: (preset: CompressionJob['preset']) => void; resume:()=>void } | null = null;
  constructor(private tools: QueueState['tools'], private notify: (event?: AgentEventType) => void, private jobs: CompressionJob[] = [], private settings: AgentSettings = { preset: 'balanced', outputMode: 'next-to-originals', outputFolder: null, frameRate: DEFAULT_FRAME_RATE }) {}
  attachEstimator(hooks: { schedule: () => void; invalidateForPreset: (preset: CompressionJob['preset']) => void; resume:()=>void }) { this.estimateHooks=hooks; }
  state(): QueueState { return { jobs: this.jobs.map(j => ({ ...j })), running: Boolean(this.active) || (this.started && this.jobs.some(j => j.status === 'queued')), tools: this.tools, settings: { ...this.settings }, warning: this.warning }; }
  persisted() { return { jobs: this.jobs.map(j => ({ ...j })), settings: { ...this.settings } }; }
  updateSettings(next: Partial<AgentSettings>) {
    if (next.preset && !(next.preset in PRESETS)) throw new Error('Unknown preset.');
    if (next.outputMode && !['next-to-originals', 'chosen-folder'].includes(next.outputMode)) throw new Error('Unknown output mode.');
    if (next.frameRate !== undefined) next = { ...next, frameRate: clampFrameRate(next.frameRate) };
    const presetChanged = Boolean(next.preset && next.preset !== this.settings.preset);
    const frameRateChanged = next.frameRate !== undefined && next.frameRate !== (this.settings.frameRate ?? DEFAULT_FRAME_RATE);
    this.settings = { ...this.settings, ...next };
    if (presetChanged) for (const job of this.jobs) if (['queued', 'failed', 'interrupted', 'cancelled'].includes(job.status)) job.preset = this.settings.preset;
    if (presetChanged || frameRateChanged) this.estimateHooks?.invalidateForPreset(this.settings.preset);
    this.notify();
  }
  async add(paths: string[], allowWarnings = false): Promise<SelectionWarning[]> {
    const warnings: SelectionWarning[] = [];
    for (const inputPath of paths) {
      const canonical = path.resolve(inputPath); const duplicate = this.jobs.some(j => path.resolve(j.inputPath) === canonical && ['queued', 'processing', 'completed', 'interrupted'].includes(j.status));
      const reason = duplicate ? 'duplicate' : appearsCompressed(canonical) ? 'already-compressed' : null;
      if (reason && !allowWarnings) { warnings.push({ id: randomUUID(), fileName: path.basename(canonical), reason, message: reason === 'duplicate' ? 'This video is already in the queue.' : 'This video appears to be already compressed.' }); continue; }
      try {
        const size = await fileSize(canonical); const folder = this.settings.outputMode === 'chosen-folder' ? this.settings.outputFolder ?? undefined : undefined;
        if (this.settings.outputMode === 'chosen-folder' && !folder) throw new Error('Choose an output folder first.');
        const outputPath = await nextOutputPath(canonical, folder); const job:CompressionJob={ id: randomUUID(), inputPath: canonical, outputPath, fileName: path.basename(canonical), durationSeconds: null, originalSize: size, finalSize: null, progress: null, status: 'queued', error: null, preset: this.settings.preset, estimateStatus:'waiting',estimatedOutputBytes:null,estimatedSavingPercent:null,estimateRangeMinBytes:null,estimateRangeMaxBytes:null,estimateProgress:null,estimateError:null,estimatePreset:this.settings.preset };this.jobs.push(job);this.notify('estimate:queued');this.estimateHooks?.schedule();if(this.tools.ffprobe){job.durationSeconds=await probeDuration(canonical);job.progress=job.durationSeconds?0:null;this.notify()}
      } catch { /* disappeared or inaccessible selection */ }
    }
    this.notify('estimate:queued'); this.estimateHooks?.schedule(); return warnings;
  }
  async start() { this.warning = await this.diskWarning(); this.started = true; this.notify(); void this.pump(); }
  async cancel(id: string) { const job = this.jobs.find(j => j.id === id); if (!job || job.status !== 'processing') return false; job.status = 'cancelled'; job.error = 'Compression was cancelled.'; job.estimateStatus='waiting';job.estimatedOutputBytes=null;job.estimatedSavingPercent=null;job.estimateRangeMinBytes=null;job.estimateRangeMaxBytes=null;job.estimateProgress=null;job.estimateError=null;job.estimatePreset=job.preset;this.active?.kill('SIGTERM'); this.notify('estimate:queued');this.estimateHooks?.schedule(); return true; }
  remove(id: string) { const before = this.jobs.length; this.jobs = this.jobs.filter(j => !(j.id === id && j.status === 'queued')); this.notify(); return before !== this.jobs.length; }
  retry(id: string) { const job = this.jobs.find(j => j.id === id); if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status)) return false; job.status = 'queued'; job.error = null; job.progress = job.durationSeconds ? 0 : null; job.finalSize = null; this.notify(); if (this.started) void this.pump(); return true; }
  clearCompleted() { this.jobs = this.jobs.filter(j => !['completed', 'failed', 'cancelled'].includes(j.status)); this.notify(); }
  outputFolder(): string | null { const done = this.jobs.find(j => j.status === 'completed'); return done ? path.dirname(done.outputPath) : this.settings.outputFolder; }
  async shutdown(){const child=this.active;if(!child)return;child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('close',()=>resolve())),new Promise<void>(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve()},2000))])}
  updateEstimate(id:string,patch:Partial<CompressionJob>,event:AgentEventType){const job=this.jobs.find(j=>j.id===id);if(!job||job.status==='completed')return;Object.assign(job,patch);this.notify(event)}
  estimationJobs(){return this.jobs.map(j=>({...j,estimateProgress:j.estimateProgress?{...j.estimateProgress}:null}))}
  private async diskWarning() {
    const queued = this.jobs.filter(j => j.status === 'queued'); if (!queued.length) return null;
    const byFolder = new Map<string, number>(); for (const j of queued) byFolder.set(path.dirname(j.outputPath), (byFolder.get(path.dirname(j.outputPath)) ?? 0) + j.originalSize);
    for (const [folder, required] of byFolder) { try { const info = await statfs(folder); const free = info.bavail * info.bsize; if (free < required * 1.1) return `Free space may be insufficient in ${folder}. Compression will continue, but consider freeing disk space.`; } catch { return `Could not check free space in ${folder}.`; } }
    return null;
  }
  private async pump() {
    if (this.active || !this.started) return; const job = this.jobs.find(j => j.status === 'queued'); if (!job) { this.started = false; this.notify(); this.estimateHooks?.resume(); return; }
    job.status = 'processing'; job.error = null; this.notify();
    try {
      await access(job.inputPath); let result = await this.run(job, false);
      if (!isCancelled(job) && result.code !== 0 && PRESETS[job.preset].audioCopyFirst && isAudioCopyFailure(result.stderr)) { await unlink(job.outputPath).catch(() => {}); job.progress = job.durationSeconds ? 0 : null; this.notify(); result = await this.run(job, true); }
      if (isCancelled(job)) await unlink(job.outputPath).catch(() => {});
      else if (result.code === 0) { job.status = 'completed'; job.progress = 100; job.finalSize = await fileSize(job.outputPath); job.estimateStatus='cancelled'; job.estimateProgress=null; }
      else { job.status = 'failed'; job.error = friendlyError(result.stderr); await unlink(job.outputPath).catch(() => {}); }
    } catch (error) { job.status = 'failed'; job.error = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'The source file is no longer available.' : 'The file could not be processed.'; }
    finally { this.active = null; this.notify(); queueMicrotask(() => void this.pump()); }
  }
  private async run(job: CompressionJob, fallback: boolean) { const operation = encodeVideo(job.inputPath, job.outputPath, job.durationSeconds, job.preset, fallback, value => { job.progress = value; this.notify(); }, this.settings.frameRate); this.active = operation.child; return operation.done; }
}
function friendlyError(stderr: string) { if (/no space left on device/i.test(stderr)) return 'There is not enough free disk space.'; if (/permission denied|read-only file system/i.test(stderr)) return 'The destination folder is not writable.'; if (/invalid data found|could not find codec parameters/i.test(stderr)) return 'This video format is not supported or the file is damaged.'; return 'FFmpeg could not compress this video. See the local agent log for details.'; }
function isCancelled(job: CompressionJob) { return job.status === 'cancelled'; }
