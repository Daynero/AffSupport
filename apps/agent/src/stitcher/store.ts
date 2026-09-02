/**
 * The stitcher's persisted state.
 *
 * Only two things are worth surviving a restart: the settings the user chose, and the list
 * of what has been produced. A run itself cannot survive — its temp directory is gone — so
 * the queue marks anything found mid-flight as interrupted rather than resuming it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultStitchSettings,
  parseStitchSettingsPatch,
  type StitchJob,
  type StitchSettings
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';

/** Enough history to answer "where did that file go", not enough to grow forever. */
const MAX_REMEMBERED_JOBS = 50;

export interface StitcherPersistedState {
  settings: StitchSettings;
  jobs: StitchJob[];
}

export function stitcherStatePath(root = applicationSupportRoot()): string {
  return path.join(root, 'stitcher', 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored job is untrusted like anything else off disk: unrecognisable entries are dropped. */
function parseJob(value: unknown): StitchJob | null {
  if (!isRecord(value)) return null;
  const { id, sourcePath, status } = value;
  if (typeof id !== 'string' || typeof sourcePath !== 'string') return null;
  if (
    status !== 'ready' &&
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed' &&
    status !== 'cancelled'
  )
    return null;
  const job = value as unknown as StitchJob;
  /* A job written by an older build has no before/after figures. Filling them in beats
     dropping the row — and beats handing the interface a job whose `source` is undefined,
     which is exactly how one stale entry took the whole page down.

     A plan and a detection are absent by design on a row that has not run: both are decided
     by the run. Requiring them here quietly threw away every waiting row on restart. */
  return {
    ...job,
    source: isRecord(value.source)
      ? job.source
      : { sizeBytes: 0, durationSeconds: 0, width: 0, height: 0, frameRate: 0, codec: '' },
    result: isRecord(value.result) ? job.result : null,
    detected: isRecord(value.detected) ? job.detected : null,
    plan: isRecord(value.plan) ? job.plan : null
  };
}

export async function loadStitcherState(
  root = applicationSupportRoot()
): Promise<StitcherPersistedState> {
  try {
    const raw: unknown = JSON.parse(await readFile(stitcherStatePath(root), 'utf8'));
    if (!isRecord(raw)) return { settings: defaultStitchSettings(), jobs: [] };
    const patch = parseStitchSettingsPatch(raw.settings);
    const jobs = Array.isArray(raw.jobs)
      ? raw.jobs.map(parseJob).filter((job): job is StitchJob => job !== null)
      : [];
    return {
      settings: { ...defaultStitchSettings(), ...(patch.ok ? patch.value : {}) },
      jobs: jobs.slice(-MAX_REMEMBERED_JOBS)
    };
  } catch {
    return { settings: defaultStitchSettings(), jobs: [] };
  }
}

/**
 * Written through a temp file and renamed, so a crash mid-write cannot leave a state file
 * that parses as half a list.
 */
export async function saveStitcherState(
  state: StitcherPersistedState,
  root = applicationSupportRoot()
): Promise<void> {
  const target = stitcherStatePath(root);
  const staging = `${target}.tmp`;
  const payload = JSON.stringify(
    { settings: state.settings, jobs: state.jobs.slice(-MAX_REMEMBERED_JOBS) },
    null,
    2
  );
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(staging, payload, 'utf8');
    await rename(staging, target);
  } catch {
    // Losing the history is not worth failing a run over.
  }
}
