/** Original transcript content and batch scope. */
export type TranscriptionCopyContent = 'transcript';
export type TranscriptionCopyScope = 'finished' | 'selected';
export interface TranscriptionCopyEntry {
  fileName: string;
  transcript: string;
}
export interface TranscriptionCopyLabels {
  heading: (number: number) => string;
  transcript: string;
}
export function hasCopyContent(
  entry: TranscriptionCopyEntry,
  _content: TranscriptionCopyContent
): boolean {
  return Boolean(entry.transcript.trim());
}
export function formatTranscriptionBatch(
  entries: readonly TranscriptionCopyEntry[],
  content: TranscriptionCopyContent,
  labels: TranscriptionCopyLabels
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (!hasCopyContent(entry, content)) continue;
    blocks.push(
      labels.heading(blocks.length + 1) + ' ' + entry.fileName + '\n' + entry.transcript.trim()
    );
  }
  return blocks.join('\n\n');
}
