import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { activeGovernorOrNull, spawnTracked } from '../power/spawn.js';
import type { AlignmentLink, TranscriptSegment, TranscriptWord } from '@video-compressor/shared';
import {
  ALIGNMENT_MODEL_DESCRIPTOR,
  alignmentModelPath,
  alignmentModelPresent,
  translationRuntimePath,
  translationRuntimePresent
} from './tools.js';
import { localLlamaHttpRequest, reserveLoopbackPort } from './translator.js';

export interface AlignmentInputSegment {
  source: TranscriptSegment;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface Aligner {
  available(): boolean;
  modelVersion(): string;
  align(segment: AlignmentInputSegment, signal: AbortSignal): Promise<AlignmentLink[]>;
  close?(): Promise<void>;
}

interface TextUnit {
  start: number;
  end: number;
  text: string;
  tokenStart: number;
  tokenEnd: number;
}

interface EmbeddingResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
}

const ALIGNER_IDLE_MS = 60_000;

/**
 * Local multilingual semantic aligner backed by Multilingual E5 Small. The
 * engine compares contextual word/phrase embeddings, supports one-to-many and
 * many-to-one links, and reports confidence derived from cosine similarity and
 * nearest-neighbour margin.
 */
const ALIGNER_START_TIMEOUT_MS = 45_000;

/** A wall-clock budget stretched to match the resource limit in force. */
function scaled(milliseconds: number): number {
  return activeGovernorOrNull()?.scaleTimeout(milliseconds) ?? milliseconds;
}

export class E5Aligner implements Aligner {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private apiKey = '';
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inferenceTail: Promise<void> = Promise.resolve();

  available(): boolean {
    return alignmentModelPresent() && translationRuntimePresent();
  }

  modelVersion(): string {
    return `multilingual-e5-small-q4_k_m@${ALIGNMENT_MODEL_DESCRIPTOR.sha256.slice(0, 16)}`;
  }

  async align(segment: AlignmentInputSegment, signal: AbortSignal): Promise<AlignmentLink[]> {
    if (!this.available()) return [];
    const sourceTokens = sourceUnits(segment.source, segment.sourceLanguage);
    const targetTokens = segmentText(segment.translatedText, segment.targetLanguage);
    if (!sourceTokens.length || !targetTokens.length) return [];

    const sourcePhrases = phrases(sourceTokens);
    const targetPhrases = phrases(targetTokens);
    const inputs = [...sourcePhrases, ...targetPhrases].map(unit => `query: ${unit.text}`);
    return this.withInferenceLock(signal, async () => {
      await this.ensureServer(signal);
      this.clearIdleTimer();
      try {
        const vectors = await this.embed(inputs, signal);
        if (vectors.length !== inputs.length) return [];
        return alignEmbeddingUnits(
          sourceTokens,
          targetTokens,
          sourcePhrases,
          targetPhrases,
          vectors.slice(0, sourcePhrases.length),
          vectors.slice(sourcePhrases.length)
        );
      } finally {
        this.scheduleIdleExit();
      }
    });
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    this.port = null;
    if (child?.exitCode === null) {
      await new Promise<void>(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
        force.unref();
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
  }

  private async ensureServer(signal: AbortSignal): Promise<void> {
    if (this.child?.exitCode === null && this.port) return;
    if (!this.starting) {
      this.starting = this.startServer().finally(() => {
        this.starting = null;
      });
    }
    await raceAbort(this.starting, signal);
  }

  private async withInferenceLock<T>(signal: AbortSignal, inference: () => Promise<T>): Promise<T> {
    const predecessor = this.inferenceTail;
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    this.inferenceTail = predecessor.catch(() => undefined).then(() => gate);
    try {
      await raceAbort(predecessor, signal);
      return await inference();
    } finally {
      release();
    }
  }

  private async startServer(): Promise<void> {
    await this.close();
    const port = await reserveLoopbackPort();
    const apiKey = randomBytes(32).toString('hex');
    const child = spawnTracked(
      translationRuntimePath(),
      [
        '--model',
        alignmentModelPath(),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--api-key',
        apiKey,
        '--embedding',
        '--pooling',
        'mean',
        '--ctx-size',
        '512',
        '--batch-size',
        '512',
        '--parallel',
        '1',
        // Keep the small E5 model on CPU. Starting a second Metal-backed
        // llama.cpp process while TranslateGemma is warm can block for well
        // over a minute on Apple Silicon; CPU startup is sub-second and a
        // typical segment embedding batch completes in under a second.
        '--n-gpu-layers',
        '0',
        '--no-webui',
        '--log-disable'
      ],
      { toolId: 'translation-align', stdio: ['ignore', 'ignore', 'ignore'] }
    );
    this.child = child;
    this.port = port;
    this.apiKey = apiKey;
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });

    // Scaled, never raw: the embedding runtime is duty-cycled like every other
    // managed child, so at a 20% limit a cold load takes roughly five times as
    // long and a fixed budget would fail it for honouring the user's setting.
    const deadline = Date.now() + scaled(ALIGNER_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('The local alignment engine could not start.');
      const health = await localLlamaHttpRequest(port, apiKey, 'GET', '/health').catch(() => null);
      if (health?.statusCode === 200) return;
      await delay(100);
    }
    await this.close();
    throw new Error('The local alignment model took too long to load.');
  }

  private async embed(input: string[], signal: AbortSignal): Promise<number[][]> {
    if (!this.port) return [];
    const response = await localLlamaHttpRequest(
      this.port,
      this.apiKey,
      'POST',
      '/v1/embeddings',
      { model: 'wishly-alignment', input, encoding_format: 'float' },
      signal
    );
    if (response.statusCode < 200 || response.statusCode >= 300) return [];
    let parsed: EmbeddingResponse;
    try {
      parsed = JSON.parse(response.body) as EmbeddingResponse;
    } catch {
      return [];
    }
    const ordered = [...(parsed.data ?? [])].sort(
      (left, right) => Number(left.index) - Number(right.index)
    );
    return ordered.map(item =>
      Array.isArray(item.embedding)
        ? item.embedding.filter((value): value is number => typeof value === 'number')
        : []
    );
  }

  private scheduleIdleExit(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close();
    }, ALIGNER_IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function sourceUnits(segment: TranscriptSegment, language: string): TextUnit[] {
  if (segment.words.length) {
    return segment.words
      .filter(word => word.sourceEnd > word.sourceStart && word.text.trim())
      .slice(0, 64)
      .map((word, index) => wordUnit(word, index));
  }
  return segmentText(segment.sourceText, language);
}

function wordUnit(word: TranscriptWord, index: number): TextUnit {
  return {
    start: word.sourceStart,
    end: word.sourceEnd,
    text: word.text,
    tokenStart: index,
    tokenEnd: index + 1
  };
}

function segmentText(text: string, language: string): TextUnit[] {
  const units: TextUnit[] = [];
  try {
    const segmenter = new Intl.Segmenter(language || 'und', { granularity: 'word' });
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike || !part.segment.trim()) continue;
      units.push({
        start: part.index,
        end: part.index + part.segment.length,
        text: part.segment,
        tokenStart: units.length,
        tokenEnd: units.length + 1
      });
      if (units.length >= 64) break;
    }
  } catch {
    for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
      const start = match.index ?? 0;
      units.push({
        start,
        end: start + match[0].length,
        text: match[0],
        tokenStart: units.length,
        tokenEnd: units.length + 1
      });
      if (units.length >= 64) break;
    }
  }
  return units;
}

function phrases(tokens: TextUnit[]): TextUnit[] {
  const result: TextUnit[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let width = 1; width <= 3 && start + width <= tokens.length; width += 1) {
      const slice = tokens.slice(start, start + width);
      result.push({
        start: slice[0].start,
        end: slice.at(-1)!.end,
        text: slice.map(unit => unit.text).join(' '),
        tokenStart: start,
        tokenEnd: start + width
      });
    }
  }
  return result;
}

/**
 * Pure nearest-neighbour alignment, exported for deterministic fixtures.
 * E5 embeddings are L2-normalized by llama.cpp, so dot product is cosine.
 */
export function alignEmbeddingUnits(
  sourceTokens: TextUnit[],
  targetTokens: TextUnit[],
  sourcePhrases: TextUnit[],
  targetPhrases: TextUnit[],
  sourceVectors: number[][],
  targetVectors: number[][]
): AlignmentLink[] {
  const links = new Map<string, AlignmentLink>();
  const sourceSingles = sourcePhrases
    .map((unit, index) => ({ unit, index }))
    .filter(entry => entry.unit.tokenEnd - entry.unit.tokenStart === 1);
  const targetSingles = targetPhrases
    .map((unit, index) => ({ unit, index }))
    .filter(entry => entry.unit.tokenEnd - entry.unit.tokenStart === 1);

  // Establish conservative one-to-one anchors first. A global edge ordering
  // avoids the same high-frequency word claiming several unrelated target
  // words, while still allowing reordered translations.
  const edges = sourceSingles
    .flatMap(source =>
      targetSingles.map(target => ({
        source,
        target,
        score: cosine(sourceVectors[source.index], targetVectors[target.index])
      }))
    )
    .sort((left, right) => right.score - left.score);
  const usedSource = new Set<number>();
  const usedTarget = new Set<number>();
  const anchors: Array<{
    source: (typeof sourceSingles)[number];
    target: (typeof targetSingles)[number];
    score: number;
  }> = [];
  for (const edge of edges) {
    if (edge.score < 0.72) break;
    const sourceToken = edge.source.unit.tokenStart;
    const targetToken = edge.target.unit.tokenStart;
    if (usedSource.has(sourceToken) || usedTarget.has(targetToken)) continue;
    usedSource.add(sourceToken);
    usedTarget.add(targetToken);
    anchors.push(edge);
  }

  for (const anchor of anchors) {
    const alternatives = edges
      .filter(
        edge =>
          edge.source.unit.tokenStart === anchor.source.unit.tokenStart &&
          edge.target.unit.tokenStart !== anchor.target.unit.tokenStart
      )
      .map(edge => edge.score)
      .sort((left, right) => right - left);
    let sourceUnit = anchor.source.unit;
    let targetUnit = anchor.target.unit;

    // Expand an anchor to an adjacent phrase only when the phrase embedding is
    // materially better and it does not consume a token anchored elsewhere.
    const targetExpansion = bestPhraseExpansion(
      anchor.source,
      anchor.target.unit.tokenStart,
      targetPhrases,
      sourceVectors[anchor.source.index],
      targetVectors,
      usedTarget
    );
    if (targetExpansion && targetExpansion.score >= anchor.score + 0.055) {
      targetUnit = targetExpansion.unit;
      for (let token = targetUnit.tokenStart; token < targetUnit.tokenEnd; token += 1) {
        usedTarget.add(token);
      }
    }
    const sourceExpansion = bestPhraseExpansion(
      anchor.target,
      anchor.source.unit.tokenStart,
      sourcePhrases,
      targetVectors[anchor.target.index],
      sourceVectors,
      usedSource
    );
    if (sourceExpansion && sourceExpansion.score >= anchor.score + 0.055) {
      sourceUnit = sourceExpansion.unit;
      for (let token = sourceUnit.tokenStart; token < sourceUnit.tokenEnd; token += 1) {
        usedSource.add(token);
      }
    }

    const score = Math.max(
      anchor.score,
      targetExpansion?.score ?? -1,
      sourceExpansion?.score ?? -1
    );
    addLink(links, sourceUnit, targetUnit, calibratedConfidence(score, alternatives[0] ?? 0));
  }

  // Keep character ranges valid and stable in document order.
  return [...links.values()].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.targetStart - right.targetStart
  );
}

function bestPhraseExpansion(
  anchor: { unit: TextUnit },
  anchorToken: number,
  phrases_: TextUnit[],
  anchorVector: number[],
  phraseVectors: number[][],
  usedTokens: Set<number>
): { unit: TextUnit; score: number } | null {
  let best: { unit: TextUnit; score: number } | null = null;
  for (let index = 0; index < phrases_.length; index += 1) {
    const phrase = phrases_[index];
    if (
      phrase.tokenEnd - phrase.tokenStart <= 1 ||
      anchorToken < phrase.tokenStart ||
      anchorToken >= phrase.tokenEnd
    ) {
      continue;
    }
    let conflicts = false;
    for (let token = phrase.tokenStart; token < phrase.tokenEnd; token += 1) {
      if (token !== anchorToken && usedTokens.has(token)) {
        conflicts = true;
        break;
      }
    }
    if (conflicts) continue;
    const score = cosine(anchorVector, phraseVectors[index]);
    if (!best || score > best.score) best = { unit: phrase, score };
  }
  return best;
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

function calibratedConfidence(best: number, second = 0): number {
  // E5 documents that cosine values cluster around 0.7–1.0. Combine absolute
  // similarity with the nearest-neighbour margin; both are measured outputs.
  const absolute = clamp((best - 0.68) / 0.27);
  const margin = clamp((best - second) / 0.14);
  return clamp(absolute * 0.8 + margin * 0.2);
}

function addLink(
  links: Map<string, AlignmentLink>,
  source: TextUnit,
  target: TextUnit,
  confidence: number
): void {
  const key = `${source.start}:${source.end}:${target.start}:${target.end}`;
  const previous = links.get(key);
  if (previous && previous.confidence >= confidence) return;
  links.set(key, {
    sourceStart: source.start,
    sourceEnd: source.end,
    targetStart: target.start,
    targetEnd: target.end,
    confidence
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createAligner(): Aligner {
  return new E5Aligner();
}
