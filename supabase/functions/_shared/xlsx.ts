/**
 * The smallest XLSX that Google Drive converts into a spreadsheet (feature 022).
 *
 * Why a workbook and not CSV: a CSV cell is parsed on import, so `-Lightweight` becomes a formula
 * error and a long digit run turns into `8.80609E+12`. In a workbook every cell says what it is —
 * a shared string or a number — and there is no `<f>` element anywhere, so nothing a person typed
 * can be evaluated.
 *
 * Why stored (uncompressed) ZIP entries: no dependency, and the size does not need it — shared
 * strings already collapse the rows, which repeat the same title, description and links.
 */

export type XlsxCell = { t: 'string'; v: string } | { t: 'number'; v: number };

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

function worksheetXml(rows: readonly (readonly XlsxCell[])[], strings: Map<string, number>) {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  ];
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    parts.push(`<row r="${rowNumber}">`);
    row.forEach((cell, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowNumber}`;
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
  parts.push('</sheetData></worksheet>');
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
  data: Uint8Array;
  crc: number;
  offset: number;
}

function zipStored(
  files: ReadonlyArray<{ name: string; data: Uint8Array }>
): Uint8Array<ArrayBuffer> {
  const entries: ZipEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // stored
    view.setUint16(10, 0, true); // time
    view.setUint16(12, 0x21, true); // date: 1980-01-01
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    header.set(name, 30);
    entries.push({ name, data: file.data, crc, offset });
    chunks.push(header, file.data);
    offset += header.length + file.data.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    const record = new Uint8Array(46 + entry.name.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x21, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
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

export function buildXlsx(input: {
  sheetName: string;
  rows: readonly (readonly XlsxCell[])[];
}): Uint8Array<ArrayBuffer> {
  if (!/^[^\\/?*[\]:]{1,31}$/u.test(input.sheetName)) {
    throw new RangeError('sheet name is not a valid worksheet name');
  }
  const strings = new Map<string, number>();
  const sheet = worksheetXml(input.rows, strings);
  const files = [
    {
      name: '[Content_Types].xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
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
        `<sheets><sheet name="${xmlText(input.sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'
    },
    { name: 'xl/worksheets/sheet1.xml', xml: sheet },
    { name: 'xl/sharedStrings.xml', xml: sharedStringsXml(strings, stringUses(input.rows)) },
    {
      name: 'xl/styles.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '</styleSheet>'
    }
  ];
  return zipStored(files.map(file => ({ name: file.name, data: encoder.encode(file.xml) })));
}
