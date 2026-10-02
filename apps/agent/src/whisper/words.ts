import type { TranscriptSegment, TranscriptWord } from '@video-compressor/shared';
import { lexicalUnitSpans } from '../translation/segmentation.js';

/**
 * Word-level timestamps derived from whisper.cpp `--output-json-full`.
 *
 * whisper emits sub-word *tokens*, each with millisecond `offsets` and a
 * probability `p`. We merge tokens into visible words (a token that starts with
 * a leading space, or the first token, begins a new word; continuation pieces
 * append), skip whisper's special tokens (`[_BEG_]`, `[_TT_..]`, `<|..|>`), and
 * carry a per-word confidence. Everything here is pure so it can be unit-tested
 * with fixtures instead of a multi-gigabyte model.
 */
export interface WhisperWord {
  /** The visible word, no surrounding whitespace. */
  text: string;
  /** True when whisper emitted a leading space before this word. */
  leadingSpace: boolean;
  startMs: number;
  endMs: number;
  /** Mean token probability 0–1, or null when whisper gave none. */
  confidence: number | null;
  /** Offsets into the authoritative stitched TXT, when provenance is available. */
  canonicalStart?: number;
  canonicalEnd?: number;
}

/** Attach exact TXT offsets before stitching, keeping timing provenance at seams. */
export function canonicalChunkWords(text: string, words: WhisperWord[]): WhisperWord[] {
  const spans = lexicalUnitSpans(text);
  return alignWordMatches(text, words)
    .map(match => {
      const word = words[match.index];
      const span = spans[match.sourceIndex];
      return {
        ...word,
        text: text.slice(span.start, span.end),
        startMs:
          word.startMs +
          Math.round(((word.endMs - word.startMs) * match.unitIndex) / match.unitCount),
        endMs:
          word.startMs +
          Math.round(((word.endMs - word.startMs) * (match.unitIndex + 1)) / match.unitCount),
        canonicalStart: span.start,
        canonicalEnd: span.end
      };
    })
    .filter(word => word.endMs > word.startMs);
}

/** Keep timing tokens aligned with a window's canonical TXT, not discarded decodes. */
export function alignWhisperWords(text: string, words: WhisperWord[]): WhisperWord[] {
  const indexes = new Set(alignWordMatches(text, words).map(match => match.index));
  return words.filter((_, index) => indexes.has(index));
}

function alignWordMatches(text: string, words: WhisperWord[]) {
  const units = (value: string) =>
    lexicalUnitSpans(value).map(span =>
      value.slice(span.start, span.end).normalize('NFKC').toLocaleLowerCase()
    );
  const source = units(text);
  const candidates = words.flatMap((word, index) => {
    const parts = units(word.text);
    return parts.map((key, unitIndex) => ({ key, index, unitIndex, unitCount: parts.length }));
  });
  const width = candidates.length + 1;
  // Windows are bounded to eight seconds: this table remains small even for
  // scripts with several tokens per word. LCS prevents a common word from
  // stealing the timestamp of its later occurrence after a discarded decode.
  const table = new Uint16Array((source.length + 1) * width);
  for (let i = source.length - 1; i >= 0; i -= 1) {
    for (let j = candidates.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        source[i] === candidates[j].key
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const matches: { index: number; sourceIndex: number; unitIndex: number; unitCount: number }[] =
    [];
  let i = 0;
  let j = 0;
  while (i < source.length && j < candidates.length) {
    if (source[i] === candidates[j].key) {
      matches.push({ ...candidates[j], sourceIndex: i });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] > table[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

interface WhisperToken {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
  p?: unknown;
}
interface WhisperSegment {
  offsets?: { from?: unknown; to?: unknown };
  text?: unknown;
  tokens?: unknown;
}

const SPECIAL_TOKEN = /^\s*(\[.*\]|<\|.*\|>)\s*$/u;
const SENTENCE_END = /[.!?…।॥؟。！？]$/u;
const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parses whisper full-JSON text into words, shifting every timestamp by
 * `offsetMs` (a chunk's absolute start). Tolerant of missing fields: anything
 * malformed is skipped rather than throwing.
 */
export function parseWhisperFullJson(jsonText: string, offsetMs: number): WhisperWord[] {
  let parsed: { transcription?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { transcription?: unknown };
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const segments = Array.isArray(parsed.transcription)
    ? (parsed.transcription as WhisperSegment[])
    : [];

  const words: WhisperWord[] = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const tokens = Array.isArray(segment.tokens) ? (segment.tokens as WhisperToken[]) : [];
    let current: WhisperWord | null = null;
    let probs: number[] = [];

    const flush = () => {
      if (!current) return;
      current.confidence = probs.length
        ? probs.reduce((total, value) => total + value, 0) / probs.length
        : null;
      if (current.text) words.push(current);
      current = null;
      probs = [];
    };

    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue;
      const raw = typeof token.text === 'string' ? token.text : '';
      if (!raw || SPECIAL_TOKEN.test(raw)) continue;
      const from = num(token.offsets?.from);
      const to = num(token.offsets?.to);
      if (from === null || to === null || from < 0 || to < from) continue;

      const startMs = offsetMs + from;
      const endMs = offsetMs + to;
      const leading = /^\s/u.test(raw);
      const piece = raw.trim();
      if (!piece) continue;

      // Whisper's English-style BPE tokens use a leading space to mark a new
      // visible word. CJK/Thai/Lao/Khmer/Myanmar normally have no spaces, so
      // treating every following token as a sub-word would collapse a whole
      // sentence into one late karaoke jump. Preserve those timestamped tokens
      // as independent highlight units while punctuation still attaches.
      const startsNoSpaceUnit =
        !leading &&
        current !== null &&
        NO_SPACE_SCRIPT.test(current.text) &&
        NO_SPACE_SCRIPT.test(piece);
      if (!current || leading || startsNoSpaceUnit) {
        flush();
        current = { text: piece, leadingSpace: leading, startMs, endMs, confidence: null };
      } else {
        // Sub-word continuation: extend the current word and its span.
        current.text += piece;
        current.endMs = Math.max(current.endMs, endMs);
      }
      const p = num(token.p);
      if (p !== null && p >= 0 && p <= 1) probs.push(p);
    }
    flush();
  }
  return words;
}

/**
 * Merges words from overlapping chunks into one monotonic sequence. Adjacent
 * whisper windows overlap ~50%, so the same word appears twice with near-equal
 * timestamps — we drop a later word when an already-kept word has the same
 * normalized text and a substantially overlapping time span. Timestamps are
 * then forced monotonic and never inverted.
 */
export function mergeChunkWords(chunks: WhisperWord[][]): WhisperWord[] {
  // Keep every word (losing words hurts coverage), but repair each span without
  // moving it behind the previous word. The old cumulative `floor =
  // previous.endMs` clamp shifted every small overlap forward; over a long
  // transcript that created visible karaoke drift.
  const kept: WhisperWord[] = [];
  const candidatesByText = new Map<string, number[]>();
  for (const chunk of chunks) {
    for (const input of chunk) {
      const word = (() => {
        const startMs = Math.max(0, Math.round(input.startMs));
        const endMs = Math.max(startMs, Math.round(input.endMs));
        return { ...input, startMs, endMs };
      })();

      // Preserve the earlier chunk's timing when two windows decode the same
      // spoken word with equal confidence. Sorting first used to accidentally
      // prefer whichever duplicate had the smallest start timestamp, which
      // could move a boundary backwards by a few hundred milliseconds. A
      // materially higher-confidence duplicate may replace it.
      const normalized = normalizeWord(word.text);
      const candidates = candidatesByText.get(normalized) ?? [];
      let duplicateIndex = -1;
      // Only overlapping windows can duplicate a word. Search the recent
      // occurrences of the same normalized token instead of the whole
      // transcript (which would turn long recordings into an O(n²) merge).
      for (
        let candidateIndex = candidates.length - 1, inspected = 0;
        candidateIndex >= 0 && inspected < 128;
        candidateIndex -= 1, inspected += 1
      ) {
        const keptIndex = candidates[candidateIndex];
        const candidate = kept[keptIndex];
        if (candidate.endMs < word.startMs - 2_000 || candidate.startMs > word.endMs + 2_000) {
          continue;
        }
        if (isDuplicateWord(candidate, word)) {
          duplicateIndex = keptIndex;
          break;
        }
      }
      if (duplicateIndex >= 0) {
        const previousConfidence = kept[duplicateIndex].confidence ?? -1;
        const candidateConfidence = word.confidence ?? -1;
        if (candidateConfidence > previousConfidence + 0.02) kept[duplicateIndex] = word;
        continue;
      }
      kept.push(word);
      candidates.push(kept.length - 1);
      candidatesByText.set(normalized, candidates);
    }
  }

  kept.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  // Make spans non-overlapping by shortening the earlier word to the next
  // start. Never push the next word later than the audio timestamp Whisper
  // produced — that was the source of accumulated playback lag.
  for (let index = 0; index < kept.length - 1; index += 1) {
    const nextStart = kept[index + 1].startMs;
    if (kept[index].endMs > nextStart) {
      kept[index].endMs = Math.max(kept[index].startMs, nextStart);
    }
  }
  return kept;
}

function normalizeWord(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}

function isDuplicateWord(previous: WhisperWord, candidate: WhisperWord): boolean {
  if (
    previous.canonicalStart !== undefined &&
    candidate.canonicalStart !== undefined &&
    previous.canonicalStart !== candidate.canonicalStart
  )
    return false;
  if (normalizeWord(previous.text) !== normalizeWord(candidate.text)) return false;
  const overlap =
    Math.min(previous.endMs, candidate.endMs) - Math.max(previous.startMs, candidate.startMs);
  const shorter = Math.min(previous.endMs - previous.startMs, candidate.endMs - candidate.startMs);
  // Treat as the same spoken word when the spans meaningfully overlap, or when
  // both are near-zero-length (whisper sometimes emits identical tiny spans).
  return (
    overlap >= 0 &&
    (shorter <= 0 ? Math.abs(previous.startMs - candidate.startMs) <= 250 : overlap * 2 >= shorter)
  );
}

/**
 * Groups merged words into segments, anchoring each word to character offsets
 * inside the segment's `sourceText`. A segment ends after sentence-final
 * punctuation or a long silent gap, so segments stay sentence-sized for the
 * split view. Spacing follows whisper's own `leadingSpace`, so scripts without
 * spaces (CJK, Thai) concatenate correctly.
 */
export function buildSegmentsFromWords(
  jobId: string,
  words: WhisperWord[],
  options: { gapMs?: number } = {}
): TranscriptSegment[] {
  const gapMs = options.gapMs ?? 900;
  const segments: TranscriptSegment[] = [];
  let bucket: WhisperWord[] = [];

  const commit = () => {
    if (!bucket.length) return;
    const index = segments.length;
    let sourceText = '';
    const outWords: TranscriptWord[] = [];
    for (let wordIndex = 0; wordIndex < bucket.length; wordIndex += 1) {
      const word = bucket[wordIndex];
      if (wordIndex > 0 && word.leadingSpace) sourceText += ' ';
      const sourceStart = sourceText.length;
      sourceText += word.text;
      outWords.push({
        id: `${jobId}-s${index}-w${wordIndex}`,
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        confidence: word.confidence,
        sourceStart,
        sourceEnd: sourceText.length
      });
    }
    segments.push({
      id: `${jobId}-s${index}`,
      startMs: bucket[0].startMs,
      endMs: bucket[bucket.length - 1].endMs,
      sourceText,
      words: outWords
    });
    bucket = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    bucket.push(word);
    const next = words[index + 1];
    const endsSentence = SENTENCE_END.test(word.text);
    const longGap = next ? next.startMs - word.endMs >= gapMs : false;
    const boundedSemanticUnit = bucket.length >= 40 || word.endMs - bucket[0].startMs >= 12_000;
    if (endsSentence || longGap || boundedSemanticUnit) commit();
  }
  commit();
  return segments;
}
