/** Publication-only source binding. Existing process/transfer version rules are
 * unchanged. A content proof survives metadata-only permission/rename updates;
 * a strict fallback binds the exact file+connection+Drive revision. */
export async function catalogPublicationSourceIdentity(
  input: {
    materialId: string;
    connectionId: string;
    fileId: string;
    checksum: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    driveVersion: string | null;
  },
  strict = false
): Promise<string> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (
    !uuid.test(input.materialId) ||
    !uuid.test(input.connectionId) ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(input.fileId)
  )
    throw new Error('SOURCE_CHANGED');
  const content =
    !strict &&
    typeof input.checksum === 'string' &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/iu.test(input.checksum) &&
    typeof input.mimeType === 'string' &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(input.mimeType) &&
    input.mimeType.length <= 128 &&
    Number.isSafeInteger(input.sizeBytes) &&
    Number(input.sizeBytes) >= 0;
  const mode = content ? 'content-v1' : 'strict-v1';
  if (
    !content &&
    (typeof input.driveVersion !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.driveVersion))
  )
    throw new Error('SOURCE_CHANGED');
  const fields = [
    mode,
    input.materialId.toLowerCase(),
    input.connectionId.toLowerCase(),
    input.fileId,
    ...(content
      ? [input.checksum!.toLowerCase(), input.mimeType!.toLowerCase(), String(input.sizeBytes)]
      : [input.driveVersion!])
  ];
  const encoder = new TextEncoder();
  const canonical = fields.map(field => `${encoder.encode(field).byteLength}:${field}`).join('');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
  return mode + ':' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
