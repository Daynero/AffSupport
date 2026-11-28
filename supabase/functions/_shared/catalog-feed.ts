import { TeamFunctionError } from './errors.ts';
import type { XlsxCell } from './xlsx.ts';

/**
 * The catalog feed of an R2 space (057, FR-050): the sheet a Drive space gets, written instead
 * as one CSV file under a stable public address that Meta reads on a schedule.
 *
 * The rows are the ones `buildProductCatalogRows` hands the Google writer — the Meta template's
 * description row, the key row, then the products — so the file holds byte for byte what an
 * export of the sheet would (evidence/meta-feed-from-r2-2026-11-27.md: such an export of a live
 * catalog was accepted as is). Quoting is RFC 4180; records end in CRLF; no BOM.
 *
 * Every update rewrites the same key, `feeds/{feed_id}.csv`, in the public catalog-video bucket
 * and purges that one address. A PUT either lands whole or not at all, so a failed write leaves
 * the previous feed serving. The zone forces a four-hour browser TTL, so `/feeds/*` needs its own
 * cache rule of 60 s or less (docs/PRODUCTION.md); the purge is the fast path, the rule the bound.
 *
 * The feed id is random and the address public: the rows carry tracking links, which is what
 * the sheet "anyone with the link" was too. Nothing here logs a row, a link or a token.
 */

export const CATALOG_FEED_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const CATALOG_FEED_ID = /^[0-9a-f]{32}$/u;
export const CATALOG_FEED_KEY = /^feeds\/[0-9a-f]{32}\.csv$/u;
/** The attempt that wrote a feed, kept on the object as the sheet kept it in appProperties. */
export const CATALOG_FEED_MARKER_HEADER = 'x-amz-meta-soty-feed-attempt';
const MARKER = /^[A-Za-z0-9._:-]{1,128}$/u;

export function newCatalogFeedId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function catalogFeedKey(feedId: string): string {
  if (!CATALOG_FEED_ID.test(feedId)) throw new TeamFunctionError('INVALID_INPUT');
  return `feeds/${feedId}.csv`;
}

export function validCatalogFeedMarker(marker: string): string {
  if (!MARKER.test(marker)) throw new TeamFunctionError('INVALID_INPUT');
  return marker;
}

// Text the XLSX writer drops (XML 1.0 forbids it) and lone surrogates the native writer replaces.
// eslint-disable-next-line no-control-regex -- These control ranges are intentionally removed from cell text.
const INVALID_SHEET_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/gu;
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

/** What the sheet shows for one cell, as its CSV export would spell it. */
function cellText(cell: XlsxCell): string {
  if (cell.t === 'string')
    return cell.v.replace(INVALID_SHEET_TEXT, '').replace(LONE_SURROGATE, '�');
  if (cell.t === 'decimal') return cell.v.endsWith('.00') ? cell.v.slice(0, -3) : cell.v;
  if (!Number.isFinite(cell.v)) throw new TeamFunctionError('INVALID_INPUT');
  return String(cell.v);
}

function csvField(text: string): string {
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function catalogFeedText(rows: readonly (readonly XlsxCell[])[]): string {
  if (rows.length === 0) throw new TeamFunctionError('INVALID_INPUT');
  return rows.map(row => row.map(cell => csvField(cellText(cell))).join(',')).join('\r\n');
}

export function catalogFeedCsv(rows: readonly (readonly XlsxCell[])[]): Uint8Array {
  return new TextEncoder().encode(catalogFeedText(rows));
}

/**
 * Reads a feed back into its cells — only Soty's own output, to patch one column of it (a video
 * publication) without drawing the rows again. Strict RFC 4180: anything else is refused.
 */
export function parseCatalogFeedCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let index = 0;
  let quoted = false;
  let afterQuote = false;
  const endField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
      } else field += char;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
    } else if (char === '\r' && text[index + 1] === '\n') {
      endField();
      rows.push(row);
      row = [];
      index += 1;
    } else if (char === '"' && field === '' && !afterQuote) {
      quoted = true;
    } else if (afterQuote || char === '"' || char === '\r' || char === '\n') {
      throw new TeamFunctionError('INVALID_RESPONSE');
    } else field += char;
    index += 1;
  }
  if (quoted) throw new TeamFunctionError('INVALID_RESPONSE');
  endField();
  rows.push(row);
  return rows;
}

/** The bucket side of a feed: the public catalog-video bucket and its CDN (`CatalogVideoR2`). */
export interface CatalogFeedStore {
  feedUrl(key: string): string;
  putFeed(
    key: string,
    bytes: Uint8Array,
    marker: string,
    signal: AbortSignal
  ): Promise<{ etag: string }>;
  readFeed(
    key: string,
    signal: AbortSignal
  ): Promise<{ bytes: Uint8Array; etag: string; marker: string | null } | null>;
  removeFeed(key: string, signal: AbortSignal): Promise<void>;
  purgeUrls(urls: readonly string[], signal: AbortSignal): Promise<boolean>;
}

export interface WrittenCatalogFeed {
  feedId: string;
  key: string;
  url: string;
  bytes: number;
  etag: string;
  /** False when the CDN purge failed: the feed is written and the cache rule bounds the rest. */
  purged: boolean;
}

export async function writeCatalogFeed(
  store: CatalogFeedStore,
  input: { feedId: string; rows: readonly (readonly XlsxCell[])[]; marker: string },
  signal: AbortSignal,
  log: (message: string, detail: string) => void = () => undefined
): Promise<WrittenCatalogFeed> {
  const key = catalogFeedKey(input.feedId);
  const marker = validCatalogFeedMarker(input.marker);
  const bytes = catalogFeedCsv(input.rows);
  // Nothing is removed first: until this PUT lands whole, the previous feed keeps serving.
  const { etag } = await store.putFeed(key, bytes, marker, signal);
  const url = store.feedUrl(key);
  const purged = await store.purgeUrls([url], signal).catch(() => false);
  if (!purged) log('[catalog-feed] purge failed', input.feedId);
  return { feedId: input.feedId, key, url, bytes: bytes.byteLength, etag, purged };
}
