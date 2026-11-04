import { TeamFunctionError } from './errors.ts';
import type { XlsxCell } from './xlsx.ts';

/** Experimental native writes are opt-in only through the existing local beta profile. */
export function betaNativeCatalogSheets(input: {
  enabled?: unknown;
  oauthMode: unknown;
  siteUrl: string | null | undefined;
  requestOrigin: string | null | undefined;
}): boolean {
  if (input.enabled !== 'true' || input.oauthMode !== 'testing') return false;
  try {
    const site = new URL(input.siteUrl ?? '');
    const origin = new URL(input.requestOrigin ?? '');
    return (
      site.origin === 'http://127.0.0.1:5175' &&
      ['http://127.0.0.1:5175', 'http://127.0.0.1:43140'].includes(origin.origin)
    );
  } catch {
    return false;
  }
}

export interface NativeCatalogSheet {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

// Match XML 1.0 control filtering used by the XLSX encoder.
// eslint-disable-next-line no-control-regex -- These control ranges are intentionally removed from cell text.
const INVALID_XML_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu;

/** Explicit stringValue prevents formula evaluation and preserves long IDs and leading zeros. */
export function nativeCatalogCellRows(rows: readonly (readonly XlsxCell[])[]) {
  if (rows.length === 0 || !rows.some(row => row.length))
    throw new TeamFunctionError('INVALID_INPUT');
  return rows.map(row => ({
    values: row.map(cell => {
      // With updateCells' explicit value/format mask, an empty CellData clears the cell.
      // Keep its grid position while avoiding a verbose stringValue for every blank column.
      if (cell.t === 'string' && cell.v === '') return {};
      if (cell.t === 'string')
        return {
          userEnteredValue: {
            stringValue: cell.v.replace(INVALID_XML_TEXT, '').replace(/[\ud800-\udfff]/gu, '\ufffd')
          }
        };
      if (cell.t === 'decimal') {
        if (
          !/^\d+\.\d{2}$/u.test(cell.v) ||
          cell.v.replace(/[.]/gu, '').replace(/^0+/u, '').length > 15
        )
          throw new RangeError('FINANCE_EXPORT_PRECISION');
        return {
          userEnteredValue: { numberValue: Number(cell.v) },
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: cell.v.endsWith('.00') ? '0' : '0.00' }
          }
        };
      }
      if (!Number.isFinite(cell.v)) throw new TeamFunctionError('INVALID_INPUT');
      return { userEnteredValue: { numberValue: cell.v } };
    })
  }));
}
