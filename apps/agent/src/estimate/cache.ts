import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applicationSupportRoot } from '../files/support-dir.js';
import {
  jobConfigurationKey,
  type EncodingSettings,
  type EstimateBreakdown,
  type JobImageEmbedding
} from '@video-compressor/shared';

export const ESTIMATE_ALGORITHM_VERSION = '10';
export interface CachedEstimate {
  estimatedOutputBytes: number;
  estimatedSavingPercent: number;
  estimateRangeMinBytes: number;
  estimateRangeMaxBytes: number;
  estimateBreakdown: EstimateBreakdown;
  createdAt: number;
}
interface CacheFile {
  entries: Record<string, CachedEstimate>;
}

export function defaultCachePath() {
  return process.env.AGENT_CACHE_PATH ?? path.join(applicationSupportRoot(), 'estimate-cache.json');
}

export function estimateCacheKey(
  filePath: string,
  size: number,
  mtimeMs: number,
  settings: EncodingSettings,
  imageEmbedding: JobImageEmbedding | null = null
) {
  return JSON.stringify([
    path.resolve(filePath),
    size,
    Math.round(mtimeMs),
    jobConfigurationKey(settings, imageEmbedding),
    ESTIMATE_ALGORITHM_VERSION
  ]);
}

export class EstimateCache {
  private data: CacheFile = { entries: {} };
  constructor(
    private file = defaultCachePath(),
    private maxEntries = 300
  ) {}

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.data = { entries: {} };
    }
    this.prune();
  }

  get(key: string) {
    return this.data.entries[key];
  }

  async set(key: string, value: CachedEstimate) {
    this.data.entries[key] = value;
    this.prune();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), 'utf8');
    await rename(temporary, this.file);
  }

  private prune() {
    const entries = Object.entries(this.data.entries)
      .sort((first, second) => second[1].createdAt - first[1].createdAt)
      .slice(0, this.maxEntries);
    this.data = { entries: Object.fromEntries(entries) };
  }
}
