/**
 * The smallest XLSX that Google Drive converts into a spreadsheet (feature 022).
 *
 * Why a workbook and not CSV: a CSV cell is parsed on import, so `-Lightweight` becomes a formula
 * error and a long digit run turns into `8.80609E+12`. In a workbook every cell says what it is —
 * a shared string or a number — and there is no `<f>` element anywhere, so nothing a person typed
 * can be evaluated.
 *
 * Why DEFLATE entries (023): the catalog updater uploads every selected sheet at every round, and a
 * stored 100-product workbook was 114 KB of almost the same row over and over. The platform's own
 * `CompressionStream` does it without a dependency; an entry that would not shrink stays stored.
 */

export type XlsxCell =
  { t: 'string'; v: string } | { t: 'number'; v: number } | { t: 'decimal'; v: string };
export interface XlsxSheet {
  sheetName: string;
  rows: readonly (readonly XlsxCell[])[];
  merges?: readonly string[];
  freezeRows?: number;
  freezeColumns?: number;
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Text as XML character data. Control characters other than tab and newline are not allowed in
 * XML 1.0 at all, so they are dropped rather than escaped — a sheet that fails to open is worse
 * than a missing invisible character.
 */
export function xmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function worksheetXml(
  rows: readonly (readonly XlsxCell[])[],
  strings: Map<string, number>,
  options?: XlsxSheet
) {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  ];
  if (options?.freezeRows || options?.freezeColumns) {
    const x = options.freezeColumns ?? 0;
    const y = options.freezeRows ?? 0;
    parts.push(
      `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${x}" ySplit="${y}" topLeftCell="${columnName(x)}${y + 1}" state="frozen"/></sheetView></sheetViews>`
    );
  }
  parts.push('<sheetData>');
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    parts.push(`<row r="${rowNumber}">`);
    row.forEach((cell, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowNumber}`;
      if (cell.t === 'decimal') {
        if (
          !/^\d+\.\d{2}$/u.test(cell.v) ||
          cell.v.replace(/[.]/gu, '').replace(/^0+/u, '').length > 15
        )
          throw new RangeError('FINANCE_EXPORT_PRECISION');
        parts.push(`<c r="${ref}" s="${cell.v.endsWith('.00') ? '0' : '1'}"><v>${cell.v}</v></c>`);
        return;
      }
      if (cell.t === 'number') {
        if (!Number.isFinite(cell.v)) throw new RangeError(`cell ${ref} is not a finite number`);
        parts.push(`<c r="${ref}"><v>${cell.v}</v></c>`);
        return;
      }
      if (cell.v === '') return;
      let id = strings.get(cell.v);
      if (id === undefined) {
        id = strings.size;
        strings.set(cell.v, id);
      }
      parts.push(`<c r="${ref}" t="s"><v>${id}</v></c>`);
    });
    parts.push('</row>');
  });
  parts.push('</sheetData>');
  if (options?.merges?.length) {
    if (!options.merges.every(ref => /^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/u.test(ref)))
      throw new RangeError('INVALID_INPUT');
    parts.push(
      `<mergeCells count="${options.merges.length}">${options.merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    );
  }
  parts.push('</worksheet>');
  return parts.join('');
}

function sharedStringsXml(strings: Map<string, number>, uses: number): string {
  const items = [...strings.keys()].map(value => {
    // Leading or trailing spaces vanish from `<t>` unless it asks to keep them.
    const preserve = /^\s|\s$/u.test(value) ? ' xml:space="preserve"' : '';
    return `<si><t${preserve}>${xmlText(value)}</t></si>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${uses}" uniqueCount="${strings.size}">` +
    items.join('') +
    '</sst>'
  );
}

function stringUses(rows: readonly (readonly XlsxCell[])[]): number {
  let uses = 0;
  for (const row of rows)
    for (const cell of row) if (cell.t === 'string' && cell.v !== '') uses += 1;
  return uses;
}

interface ZipEntry {
  name: Uint8Array;
  /** What is written: the deflated bytes, or the original when deflating did not help. */
  body: Uint8Array;
  method: 0 | 8;
  size: number;
  crc: number;
  offset: number;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipFiles(
  files: ReadonlyArray<{ name: string; data: Uint8Array }>
): Promise<Uint8Array<ArrayBuffer>> {
  const entries: ZipEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const deflated = await deflateRaw(file.data);
    const method = deflated.length < file.data.length ? 8 : 0;
    const body = method === 8 ? deflated : file.data;
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, method, true); // 0 stored, 8 deflated
    view.setUint16(10, 0, true); // time
    view.setUint16(12, 0x21, true); // date: 1980-01-01
    view.setUint32(14, crc, true);
    view.setUint32(18, body.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    header.set(name, 30);
    entries.push({ name, body, method, size: file.data.length, crc, offset });
    chunks.push(header, body);
    offset += header.length + body.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    const record = new Uint8Array(46 + entry.name.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x21, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.body.length, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true); // extra
    view.setUint16(32, 0, true); // comment
    view.setUint16(34, 0, true); // disk
    view.setUint16(36, 0, true); // internal attributes
    view.setUint32(38, 0, true); // external attributes
    view.setUint32(42, entry.offset, true);
    record.set(entry.name, 46);
    chunks.push(record);
    offset += record.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  chunks.push(end);
  offset += end.length;

  const out = new Uint8Array(new ArrayBuffer(offset));
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

export async function buildXlsx(input: {
  sheetName: string;
  rows: readonly (readonly XlsxCell[])[];
}): Promise<Uint8Array<ArrayBuffer>> {
  return buildWorkbook([input]);
}

export async function buildWorkbook(
  sheets: readonly XlsxSheet[]
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !sheets.length ||
    new Set(sheets.map(s => s.sheetName)).size !== sheets.length ||
    sheets.some(s => s.rows.length > 1048576 || s.rows.some(r => r.length > 16384))
  )
    throw new RangeError('FINANCE_EXPORT_SIZE');
  if (sheets.some(input => !/^[^\\/?*[\]:]{1,31}$/u.test(input.sheetName))) {
    throw new RangeError('sheet name is not a valid worksheet name');
  }
  const strings = new Map<string, number>();
  const sheetXml = sheets.map(input => worksheetXml(input.rows, strings, input));
  const files = [
    {
      name: '[Content_Types].xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'
    },
    {
      name: '_rels/.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheets.map((s, i) => `<sheet name="${xmlText(s.sheetName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        '</workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>'
    },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml })),
    {
      name: 'xl/sharedStrings.xml',
      xml: sharedStringsXml(
        strings,
        sheets.reduce((n, s) => n + stringUses(s.rows), 0)
      )
    },
    {
      name: 'xl/styles.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '</styleSheet>'
    }
  ];
  return zipFiles(files.map(file => ({ name: file.name, data: encoder.encode(file.xml) })));
}
