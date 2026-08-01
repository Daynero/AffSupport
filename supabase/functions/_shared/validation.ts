export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: 'INVALID_INPUT' };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parseJsonBody(
  request: Request,
  maximumBytes = 64 * 1024
): Promise<ParseResult<Record<string, unknown>>> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > maximumBytes)
    return { ok: false, error: 'INVALID_INPUT' };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      return { ok: false, error: 'INVALID_INPUT' };
    }
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { ok: true, value } : { ok: false, error: 'INVALID_INPUT' };
  } catch {
    return { ok: false, error: 'INVALID_INPUT' };
  }
}

export function parseUuid(value: unknown): ParseResult<string> {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? { ok: true, value: value.toLocaleLowerCase('en-US') }
    : { ok: false, error: 'INVALID_INPUT' };
}

export function parseBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  normalizeWhitespace = false
): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'INVALID_INPUT' };
  const normalized = normalizeWhitespace
    ? value.normalize('NFC').trim().replace(/\s+/g, ' ')
    : value.normalize('NFC').trim();
  return normalized.length >= minimum && normalized.length <= maximum
    ? { ok: true, value: normalized }
    : { ok: false, error: 'INVALID_INPUT' };
}

export function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): ParseResult<T[number]> {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? { ok: true, value: value as T[number] }
    : { ok: false, error: 'INVALID_INPUT' };
}

export function parseIdempotencyKey(value: unknown): ParseResult<string> {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{7,199}$/i.test(value)
    ? { ok: true, value }
    : { ok: false, error: 'INVALID_INPUT' };
}

export function parseSafePageToken(value: unknown): ParseResult<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  return typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9._~+/=-]+$/.test(value)
    ? { ok: true, value }
    : { ok: false, error: 'INVALID_INPUT' };
}
