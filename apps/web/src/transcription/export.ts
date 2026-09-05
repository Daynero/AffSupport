import type { TranscriptSegment, TranslationDocument } from '@video-compressor/shared';

/** The file shapes a transcript can leave the tool in. */
export type TranscriptExportFormat = 'txt' | 'srt' | 'vtt';

/** Which text goes into the file. */
export type TranscriptExportContent = 'transcript' | 'translation' | 'both';

export interface TranscriptExportInput {
  fileName: string;
  segments: readonly TranscriptSegment[];
  /** The translation to include, when the content asks for one. */
  translation?: TranslationDocument | null;
  content: TranscriptExportContent;
  format: TranscriptExportFormat;
}

export interface TranscriptExportFile {
  name: string;
  mimeType: string;
  text: string;
}

/** Everything after the last dot, when there is one worth dropping. */
export function baseFileName(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed || 'transcript';
}

/**
 * Whether the document carries real timings. Segments built from plain text are all at
 * zero, and a subtitle file whose every cue starts at 00:00:00 is worse than no file.
 */
export function hasTimings(segments: readonly TranscriptSegment[]): boolean {
  return segments.some(segment => segment.endMs > segment.startMs);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `HH:MM:SS,mmm` for SRT, `HH:MM:SS.mmm` for WebVTT. */
export function formatTimestamp(milliseconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(rest, 3)}`;
}

/**
 * Cue boundaries, made monotonic.
 *
 * Word timings can leave a segment's end a few milliseconds before the next one's start,
 * or two segments sharing an instant; a player handles that badly and a validator rejects
 * it. Each cue starts no earlier than the previous one ended and lasts at least a moment.
 */
function cueSpans(segments: readonly TranscriptSegment[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = Math.max(cursor, segment.startMs);
    const end = Math.max(start + 1, segment.endMs);
    spans.push({ start, end });
    cursor = end;
  }
  return spans;
}

function lines(
  segments: readonly TranscriptSegment[],
  translatedById: ReadonlyMap<string, string>,
  content: TranscriptExportContent
): string[][] {
  return segments.map(segment => {
    const source = segment.sourceText.trim();
    const translated = translatedById.get(segment.id)?.trim() ?? '';
    if (content === 'transcript') return source ? [source] : [];
    if (content === 'translation') return translated ? [translated] : [];
    return [source, translated].filter(Boolean);
  });
}

/**
 * Builds one downloadable file from a transcript.
 *
 * Plain text keeps one segment per line — with both languages, the translation follows each
 * line so a reader never has to scroll between two blocks to compare a sentence. Subtitles
 * carry the same pairing inside one cue. Cues with nothing to say are skipped, and the SRT
 * numbering is renumbered after the skip so it stays gap-free.
 */
export function buildTranscriptExport(input: TranscriptExportInput): TranscriptExportFile {
  const translatedById = new Map(
    (input.translation?.status === 'completed' ? input.translation.segments : []).map(
      segment => [segment.sourceSegmentId, segment.translatedText] as const
    )
  );
  const body = lines(input.segments, translatedById, input.content);
  const base = baseFileName(input.fileName);
  const suffix =
    input.content === 'translation' && input.translation
      ? `.${input.translation.targetLanguage}`
      : input.content === 'both' && input.translation
        ? `.bilingual`
        : '';

  if (input.format === 'txt') {
    const text = body
      .filter(entry => entry.length > 0)
      .map(entry => entry.join('\n'))
      .join(input.content === 'both' ? '\n\n' : '\n');
    return { name: `${base}${suffix}.txt`, mimeType: 'text/plain;charset=utf-8', text };
  }

  const spans = cueSpans(input.segments);
  const cues: string[] = [];
  body.forEach((entry, index) => {
    if (!entry.length) return;
    const { start, end } = spans[index];
    if (input.format === 'srt') {
      cues.push(
        `${cues.length + 1}\n${formatTimestamp(start, ',')} --> ${formatTimestamp(end, ',')}\n${entry.join('\n')}`
      );
    } else {
      cues.push(
        `${formatTimestamp(start, '.')} --> ${formatTimestamp(end, '.')}\n${entry.join('\n')}`
      );
    }
  });
  if (input.format === 'srt') {
    return {
      name: `${base}${suffix}.srt`,
      mimeType: 'application/x-subrip',
      text: cues.join('\n\n')
    };
  }
  return {
    name: `${base}${suffix}.vtt`,
    mimeType: 'text/vtt;charset=utf-8',
    text: `WEBVTT\n\n${cues.join('\n\n')}`
  };
}

/**
 * Hands a built file to the browser as a download.
 *
 * A Blob URL rather than a data URL: a two-hour transcript with both languages is well past
 * the length some browsers accept in an `href`.
 */
export function downloadTranscriptExport(file: TranscriptExportFile): void {
  const blob = new Blob([file.text], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked after the click has been handed to the download manager, not before.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
