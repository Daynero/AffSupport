/** Vendor the pinned decoder from an already-downloaded official npm tarball. */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { format, resolveConfig } from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'supabase/functions/_shared/catalog-jpeg');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check' && !arg.startsWith('--source=')))
  throw new Error(
    'Usage: node scripts/generate-catalog-jpeg-validator.mjs [--check] [--source=/path/source.tgz]'
  );
const sourcePath =
  args.find(arg => arg.startsWith('--source='))?.slice('--source='.length) ??
  path.join(root, 'release/automation/tooling/jpeg-js-0.4.4/source.tgz');
const archive = readFileSync(sourcePath);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
if (
  sha256(archive) !== '269f988267bc71efe58baf97e8b2da064b5bbbbb8b0eab11e2149049935e1160' ||
  createHash('sha512').update(archive).digest('base64') !==
    'WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg=='
)
  throw new Error('Unreviewed jpeg-js tarball; obtain the exact official 0.4.4 npm artifact.');
const tar = gunzipSync(archive, { maxOutputLength: 1_000_000 });
const entries = new Map();
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
  const length = Number.parseInt(
    header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(),
    8
  );
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    offset + 512 + length > tar.length ||
    entries.has(name)
  )
    throw new Error('Invalid pinned tar archive shape.');
  entries.set(name, tar.subarray(offset + 512, offset + 512 + length));
  offset += 512 + Math.ceil(length / 512) * 512;
}
const original = entries.get('package/lib/decoder.js');
const license = entries.get('package/LICENSE');
if (
  !original ||
  sha256(original) !== 'a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f' ||
  !license ||
  sha256(license) !== 'c0a8512eabe960492fefd4f287523eb3b5ca1518ca37ef0ec83344cd7f089cb8'
)
  throw new Error('Unexpected jpeg-js decoder or license source.');
let source = original.toString('utf8');
function replace(before, after) {
  if (source.split(before).length !== 2)
    throw new Error('A reviewed JPEG source patch is not unique.');
  source = source.replace(before, after);
}
const hostStart = source.indexOf("if (typeof module !== 'undefined') {");
const hostEnd = source.indexOf('\nfunction decode(', hostStart);
replace(source.slice(hostStart, hostEnd), '');
const loadStart = source.indexOf('    load: function load(path) {');
const loadEnd = source.indexOf('    parse: function parse(data) {', loadStart);
replace(source.slice(loadStart, loadEnd), '');
replace('    useTArray: false,', '    useTArray: true,');
replace('  var arr = new Uint8Array(jpegData);', '  var arr = jpegData;');
replace(
  'data: opts.useTArray ?\n        new Uint8Array(bytesNeeded) :\n        Buffer.alloc(bytesNeeded)',
  'data: new Uint8Array(bytesNeeded)'
);
const bufferErrorStart = source.indexOf('    if (err instanceof ReferenceError) {');
const bufferErrorEnd = source.indexOf('    throw err;', bufferErrorStart);
replace(source.slice(bufferErrorStart, bufferErrorEnd), '');
// Content metadata is irrelevant to this validator and must not create unbudgeted strings.
replace(
  `            if (fileMarker === 0xFFFE) {
              var comment = String.fromCharCode.apply(null, appData);
              this.comments.push(comment);
            }`,
  ''
);
replace(
  '      bitsData = data[offset++];',
  `      if (offset >= data.length) throw new Error('JPEG entropy ended early');
      bitsData = data[offset++];`
);
replace(
  '        var nextByte = data[offset++];',
  `        if (offset >= data.length) throw new Error('JPEG entropy ended early');
        var nextByte = data[offset++];`
);
replace(
  '        var value = (data[offset] << 8) | data[offset + 1];',
  `        if (offset + 2 > data.length) throw new Error('JPEG marker ended early');
        var value = (data[offset] << 8) | data[offset + 1];`
);
replace(
  '        var length = readUint16();\n        var array = data.subarray(offset, offset + length - 2);',
  `        var length = readUint16();
        if (length < 2 || offset + length - 2 > data.length) throw new Error('Invalid JPEG segment length');
        var array = data.subarray(offset, offset + length - 2);`
);
replace(
  '            readUint16(); // skip data length\n            frame = {};',
  '            var frameLength = readUint16();\n            frame = {};'
);
replace(
  '            frame.precision = data[offset++];',
  `            frame.precision = data[offset++];
            if (frame.extended || frame.precision !== 8) throw new Error('Unsupported JPEG frame');`
);
replace(
  '            var componentsCount = data[offset++], componentId;',
  `            var componentsCount = data[offset++], componentId;
            if (![1, 3].includes(componentsCount) || frameLength !== 8 + componentsCount * 3 || offset + componentsCount * 3 > data.length) throw new Error('Unsupported JPEG components');`
);
replace(
  '              if ( h <= 0 || v <= 0 ) {',
  '              if ( h <= 0 || v <= 0 || h > 4 || v > 4 || frame.components[componentId] ) {'
);
replace(
  '                quantizationIdx: qId',
  '                quantizationIdx: qId,\n                coefficientAl: new Int8Array(64).fill(-1)'
);
replace(
  '      var frame, resetInterval;',
  '      var frame, resetInterval;\n      var scanCount = 0, scanWork = 0;'
);
// One backing store per component avoids retaining thousands of tiny allocator blocks.
replace(
  '            requestMemoryAllocation(blocksToAllocate * 256);',
  '            requestMemoryAllocation(blocksToAllocate * 256);\n            var coefficientSlab = new Int32Array(blocksToAllocate * 64);'
);
replace(
  '              for (var j = 0; j < blocksPerLineForMcu; j++)\n                row.push(new Int32Array(64));',
  `              for (var j = 0; j < blocksPerLineForMcu; j++) {
                var blockOffset = (i * blocksPerLineForMcu + j) * 64;
                row.push(coefficientSlab.subarray(blockOffset, blockOffset + 64));
              }`
);
replace(
  '    requestMemoryAllocation(samplesPerLine * blocksPerColumn * 8);',
  '    requestMemoryAllocation(samplesPerLine * blocksPerColumn * 8);\n    var componentSlab = new Uint8Array(samplesPerLine * blocksPerColumn * 8);'
);
replace(
  '        lines.push(new Uint8Array(samplesPerLine));',
  '        lines.push(componentSlab.subarray((scanLine + i) * samplesPerLine, (scanLine + i + 1) * samplesPerLine));'
);
replace(
  '            var selectorsCount = data[offset++];',
  `            var selectorsCount = data[offset++];
            if (!frame || selectorsCount < 1 || selectorsCount > frame.componentsOrder.length || scanLength !== 6 + selectorsCount * 2 || offset + selectorsCount * 2 + 3 > data.length) throw new Error('Invalid JPEG scan header');
            var selectedIds = [];`
);
replace(
  '              component = frame.components[data[offset++]];',
  `              var selectedId = data[offset++];
              component = frame.components[selectedId];
              if (!component || selectedIds.includes(selectedId)) throw new Error('Invalid JPEG scan component');
              selectedIds.push(selectedId);`
);
replace(
  '              var tableSpec = data[offset++];',
  `              var tableSpec = data[offset++];
              if ((tableSpec >> 4) > 3 || (tableSpec & 15) > 3) throw new Error('Invalid JPEG scan table');`
);
replace(
  '            var successiveApproximation = data[offset++];',
  `            var successiveApproximation = data[offset++];
            var ah = successiveApproximation >> 4, al = successiveApproximation & 15;
            if ((!frame.progressive && (spectralStart !== 0 || spectralEnd !== 63 || ah !== 0 || al !== 0)) ||
                (frame.progressive && (spectralStart > spectralEnd || spectralEnd > 63 || (spectralStart === 0 && spectralEnd !== 0) || (spectralStart > 0 && selectorsCount !== 1) || ah > 13 || al > 13 || (ah !== 0 && ah !== al + 1)))) throw new Error('Invalid JPEG scan parameters');
            scanCount++;
            scanWork += frame.samplesPerLine * frame.scanLines;
            if (scanCount > 32) throw new Error('JPEG scan count limit exceeded');
            if (scanWork > 64000000) throw new Error('JPEG scan work limit exceeded');
            for (var selected of components) {
              if ((spectralStart === 0 && ah === 0 && !selected.huffmanTableDC) || ((spectralStart > 0 || !frame.progressive) && !selected.huffmanTableAC)) throw new Error('Missing JPEG Huffman table');
              if (frame.progressive) {
                for (var coefficient = spectralStart; coefficient <= spectralEnd; coefficient++) {
                  var previousAl = selected.coefficientAl[coefficient];
                  if (ah === 0 ? previousAl !== -1 : previousAl !== ah) throw new Error('Invalid JPEG coefficient progression');
                  selected.coefficientAl[coefficient] = al;
                }
              }
              if (spectralStart === 0 && ah === 0) {
                if (selected.decodedDC) throw new Error('Duplicate JPEG DC scan');
                selected.decodedDC = true;
              } else if (!selected.decodedDC) throw new Error('Missing JPEG DC scan');
            }`
);
replace(
  `        // Skip trailing bytes at the end of the scan - until we reach the next marker
        do {
          if (data[offset] === 0xFF) {
            if (data[offset + 1] !== 0x00) {
              break;
            }
          }
          offset += 1;
        } while (offset < data.length - 2);`,
  `        // A complete strict scan ends at a marker; do not repair extra entropy.
        if (data[offset] !== 0xFF) throw new Error('Unexpected trailing JPEG entropy');
        while (data[offset + 1] === 0xFF) offset++;`
);
replace(
  '          default:\n            if (data[offset - 3] == 0xFF &&',
  `          default:
            if (!this.opts.tolerantDecoding) throw new Error('Unknown JPEG marker');
            if (data[offset - 3] == 0xFF &&`
);
replace(
  '      if (frames.length != 1)',
  `      if (offset !== data.length) throw new Error('Trailing JPEG data');
      if (frames.length != 1)`
);
replace(
  '          cp[j].quantizationTable = quantizationTables[cp[j].quantizationIdx];',
  `          if (!cp[j].decodedDC || !quantizationTables[cp[j].quantizationIdx]) throw new Error('Missing JPEG scan or quantization table');
          cp[j].quantizationTable = quantizationTables[cp[j].quantizationIdx];`
);
replace(
  'var JpegImage = (function jpegImage()',
  '// prettier-ignore\nvar JpegImage = (function jpegImage()'
);
replace(
  'function decode(jpegData, userOpts = {})',
  '// prettier-ignore\nfunction decode(jpegData, userOpts = {})'
);
/** @type {Array<[string, string, number]>} */
const allocationSites = [
  ['Uint8Array', 'jpegUint8Array', 6],
  ['Int32Array', 'jpegInt32Array', 4],
  ['Int8Array', 'jpegInt8Array', 1]
];
for (const [constructor, allocator, count] of allocationSites) {
  const original = `new ${constructor}(`;
  if (source.split(original).length !== count + 1)
    throw new Error('A JPEG typed-array allocation escaped the reviewed ownership inventory.');
  source = source.split(original).join(`${allocator}(`);
}
if (/\b(?:module\.exports|window|XMLHttpRequest|Buffer\.alloc)\b/u.test(source))
  throw new Error('The decoder still contains a host loader.');
const header = `/* eslint-disable -- Generated vendored decoder; see README.md. */
/* jpeg-js 0.4.4, Copyright 2011 notmasteryet (Apache-2.0), package BSD-3-Clause.
 * Modified: offline ESM/read-only input; strict work guards; owned slabs with deterministic buffer release.
 * Regenerate with scripts/generate-catalog-jpeg-validator.mjs. Original SHA-256:
 * a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f
 */
`;
const ownership = `
// Only fresh allocations made while this synchronous validation scope is active are owned.
// Module constants are allocated before a scope starts; input buffers are always excluded.
var jpegAllocationScope;
function jpegOwnArray(array) {
  if (jpegAllocationScope && array.buffer !== jpegAllocationScope.inputBuffer)
    jpegAllocationScope.buffers.add(array.buffer);
  return array;
}
function jpegUint8Array(value) { return jpegOwnArray(new Uint8Array(value)); }
function jpegInt32Array(value) { return jpegOwnArray(new Int32Array(value)); }
function jpegInt8Array(value) { return jpegOwnArray(new Int8Array(value)); }
export function beginJpegAllocationScope(inputBuffer) {
  var transfer = ArrayBuffer.prototype.transfer;
  if (jpegAllocationScope || typeof transfer !== 'function')
    throw new Error('JPEG_RESOURCE_LIMIT');
  var scope = { inputBuffer, buffers: new Set() };
  jpegAllocationScope = scope;
  return function releaseJpegAllocations() {
    if (jpegAllocationScope !== scope) throw new Error('JPEG_RESOURCE_LIMIT');
    jpegAllocationScope = undefined;
    var failure;
    for (var buffer of scope.buffers) {
      try {
        if (buffer.byteLength) transfer.call(buffer, 0);
        if (buffer.byteLength) throw new Error('JPEG buffer release failed');
      } catch (error) { failure ??= error; }
    }
    scope.buffers.clear();
    scope.inputBuffer = undefined;
    if (failure) throw new Error('JPEG_RESOURCE_LIMIT', { cause: failure });
  };
}
`;
const generated = new Map([
  [
    'decoder.js',
    await format(header + ownership + source.trim() + '\nexport default decode;\n', {
      ...(await resolveConfig(root)),
      parser: 'babel'
    })
  ],
  ['LICENSE.bsd.txt', license.toString('utf8')]
]);
if (!args.includes('--check')) mkdirSync(output, { recursive: true });
for (const [name, contents] of generated) {
  const destination = path.join(output, name);
  if (args.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== contents)
      throw new Error(`JPEG artifact differs: ${name}`);
  } else writeFileSync(destination, contents);
}
process.stdout.write(
  `Catalog JPEG validator ${args.includes('--check') ? 'verified' : 'generated'}.\n`
);
