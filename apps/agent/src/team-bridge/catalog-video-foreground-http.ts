import { isRecord, parseTeamEdgeResult } from '@video-compressor/shared';
export const CATALOG_FOREGROUND_RESPONSE_BYTES = 512 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The backend origin the agent was configured with: HTTPS, or plain HTTP on this machine only. */
function backendOriginOf(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('INVALID_INPUT');
  }
  if (
    url.origin !== origin ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
  )
    throw new Error('INVALID_INPUT');
  return url.origin;
}
/** Native proof transport uses the existing Edge envelope, never browser auth. */
export async function callCatalogVideoForegroundHttp(
  origin: string,
  action: string,
  body: Record<string, unknown>,
  ticket?: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (!/^[a-z_]+$/u.test(action) || (ticket !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(ticket)))
    throw new Error('INVALID_INPUT');
  const response = await fetchImpl(
    backendOriginOf(origin) + '/functions/v1/drive-ops/catalog-video/foreground/' + action,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ticket ? { 'x-catalog-video-foreground': ticket } : {})
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
    }
  );
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body)
    throw new Error('PROCESS_RESULT_UNCERTAIN');
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0,
    eof = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        eof = true;
        break;
      }
      size += part.value.byteLength;
      if (size > CATALOG_FOREGROUND_RESPONSE_BYTES) throw new Error('INVALID_RESPONSE');
      parts.push(part.value);
    }
    const parsed = parseTeamEdgeResult(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
    );
    if (!parsed.ok)
      throw new Error(parsed.error.code === 'EXPIRED' ? 'AUTH_REQUIRED' : parsed.error.code);
    if (!response.ok || !isRecord(parsed.value)) throw new Error('INVALID_RESPONSE');
    return parsed.value;
  } finally {
    if (!eof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
