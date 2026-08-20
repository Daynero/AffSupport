/** Which parts of a finished transcription end up on the clipboard. */
export type TranscriptionCopyContent = 'transcript' | 'translation' | 'both';

/** Which files the copy action reaches. */
export type TranscriptionCopyScope = 'finished' | 'selected';

export interface TranscriptionCopyEntry {
  fileName: string;
  transcript: string;
  /** Present only when a translation finished for this file. */
  translation: { languageName: string; text: string } | null;
}

export interface TranscriptionCopyLabels {
  /** Numbered heading for one file, e.g. `Transcription 1:`. */
  heading: (number: number) => string;
  transcript: string;
  translation: string;
}

/** Whether this file contributes anything at all in the chosen mode. */
export function hasCopyContent(
  entry: TranscriptionCopyEntry,
  content: TranscriptionCopyContent
): boolean {
  const transcript = Boolean(entry.transcript.trim());
  const translation = Boolean(entry.translation?.text.trim());
  if (content === 'transcript') return transcript;
  if (content === 'translation') return translation;
  return transcript || translation;
}

/**
 * Lays out a batch of transcripts as plain text. Every block names its file and
 * — when both languages are copied — labels each half, so a long paste never
 * leaves the reader guessing which translation belongs to which recording.
 * Files with nothing to contribute in the chosen mode are dropped before the
 * numbering runs, so the headings stay gap-free.
 */
export function formatTranscriptionBatch(
  entries: readonly TranscriptionCopyEntry[],
  content: TranscriptionCopyContent,
  labels: TranscriptionCopyLabels
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (!hasCopyContent(entry, content)) continue;
    const transcript = entry.transcript.trim();
    const translation = entry.translation?.text.trim() ?? '';
    const body: string[] = [];
    if (content !== 'translation' && transcript) {
      body.push(content === 'both' ? `${labels.transcript}:\n${transcript}` : transcript);
    }
    if (content !== 'transcript' && translation) {
      body.push(
        content === 'both'
          ? `${labels.translation} (${entry.translation!.languageName}):\n${translation}`
          : translation
      );
    }
    const language =
      content === 'translation'
        ? ` · ${labels.translation} (${entry.translation!.languageName})`
        : '';
    const heading = `${labels.heading(blocks.length + 1)} ${entry.fileName}${language}`;
    blocks.push(`${heading}\n${body.join('\n\n')}`);
  }
  return blocks.join('\n\n');
}
