import path from 'node:path';
import type { MultipartFile } from '@fastify/multipart';

export interface UploadIntakeMeta {
  fileName: string;
  signature: string;
  sourceSize: number;
  sourceModifiedAt: number;
}

function fieldValue(field: MultipartFile['fields'][string]): string | null {
  return field && 'value' in field && typeof field.value === 'string' ? field.value : null;
}

/**
 * Reads the metadata the drop zones attach to a multipart upload: the sanitized
 * file name plus the signature/size/lastModified fields used to deduplicate the
 * upload and to find the original dropped file on disk (findDroppedSource).
 * Shared by the compressor and transcription upload routes; the storage and
 * cleanup behaviour that follows deliberately stays per-route.
 */
export function uploadIntakeMeta(part: MultipartFile, fallbackName: string): UploadIntakeMeta {
  const fileName = path.basename(part.filename || fallbackName);
  const signature = fieldValue(part.fields.signature) ?? `${fileName}:${Date.now()}`;
  const sourceSize = Number(fieldValue(part.fields.size) ?? Number.NaN);
  const sourceModifiedAt = Number(fieldValue(part.fields.lastModified) ?? Number.NaN);
  return { fileName, signature, sourceSize, sourceModifiedAt };
}
