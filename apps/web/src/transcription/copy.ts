export function formatTranscriptionBatch(
  texts: readonly string[],
  heading: (number: number) => string
): string {
  return texts.map((text, index) => `${heading(index + 1)}\n${text.trim()}`).join('\n\n');
}
