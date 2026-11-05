import { TeamFunctionError } from '../_shared/errors.ts';

export const CATALOG_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const CATALOG_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CATALOG_EXPORT_MAX_BYTES = 10 * 1024 * 1024;

export function catalogExportFileName(name: string): string {
  const base = name
    .replace(/[\\/\p{Cc}]/gu, '')
    .replace(/\.(xlsx?|csv)$/iu, '')
    .trim();
  let safe = '';
  const encoder = new TextEncoder();
  for (const character of base) {
    if (encoder.encode(safe + character).length > 200) break;
    safe += character;
  }
  return `${safe || 'catalog'}.xlsx`;
}

export function catalogExportTool(consumer: 'browser' | 'agent', version: string | null): string {
  if (!version || !/^\d{1,32}$/u.test(version)) throw new TeamFunctionError('INVALID_RESPONSE');
  return `download:${consumer}:catalog_xlsx:${version}`;
}
export function parseCatalogExportTool(
  value: string | null | undefined
): { consumer: 'browser' | 'agent'; version: string } | null {
  const match = /^download:(browser|agent):catalog_xlsx:(\d{1,32})$/u.exec(value ?? '');
  return match ? { consumer: match[1] as 'browser' | 'agent', version: match[2]! } : null;
}

/** Read at most the provider's export ceiling, including chunked responses with no length. */
export async function readCatalogExport(
  response: Response,
  signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (response.status !== 200 || !response.body) throw new TeamFunctionError('INVALID_RESPONSE');
  const rawLength = response.headers.get('content-length');
  const declared =
    rawLength === null ? null : /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) || declared < 1 || declared > CATALOG_EXPORT_MAX_BYTES)
  ) {
    await response.body.cancel().catch(() => {});
    throw new TeamFunctionError(
      declared > CATALOG_EXPORT_MAX_BYTES ? 'CATALOG_EXPORT_TOO_LARGE' : 'INVALID_RESPONSE'
    );
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > CATALOG_EXPORT_MAX_BYTES) throw new TeamFunctionError('CATALOG_EXPORT_TOO_LARGE');
      chunks.push(next.value);
    }
    if (size < 4 || (declared !== null && size !== declared))
      throw new TeamFunctionError('INVALID_RESPONSE');
    const bytes = new Uint8Array(new ArrayBuffer(size));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4)
      throw new TeamFunctionError('INVALID_RESPONSE');
    return bytes;
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof TeamFunctionError) throw cause;
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

interface CatalogExportSource {
  id: string;
  mimeType: string;
  version: string | null;
  canDownload: boolean;
}
/** Export bytes are returned only after access and source identity are confirmed again. */
export async function prepareCatalogExport(input: {
  purpose: string | undefined;
  toolId: string | null | undefined;
  source: CatalogExportSource;
  allowed: () => Promise<boolean>;
  export: () => Promise<Response>;
  reload: () => Promise<CatalogExportSource>;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const binding = parseCatalogExportTool(input.toolId);
  if (
    input.purpose !== 'download_range' ||
    !binding ||
    input.source.mimeType !== CATALOG_SHEET_MIME
  )
    throw new TeamFunctionError('UNSUPPORTED_MEDIA');
  if (!input.source.canDownload || !(await input.allowed()))
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (binding.version !== input.source.version) throw new TeamFunctionError('SOURCE_CHANGED');
  const bytes = await readCatalogExport(await input.export(), input.signal);
  const after = await input.reload();
  if (!after.canDownload || !(await input.allowed()))
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    after.id !== input.source.id ||
    after.mimeType !== CATALOG_SHEET_MIME ||
    after.version !== input.source.version
  )
    throw new TeamFunctionError('SOURCE_CHANGED');
  input.signal.throwIfAborted();
  return bytes;
}
