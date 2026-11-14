export class BodyLimitError extends Error {
  constructor() {
    super('BODY_TOO_LARGE');
    this.name = 'BodyLimitError';
  }
}

/** Enforce the byte budget while reading, including chunked or dishonest responses. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError('Invalid body budget');
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > maximumBytes - size) throw new BodyLimitError();
      if (part.value.byteLength) chunks.push(part.value);
      size += part.value.byteLength;
    }
  } catch (error) {
    // A sender (or the other branch of a tee) may never finish cancellation.
    // Stop consuming immediately without making the error response wait for it.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
