#!/usr/bin/env node
/**
 * Builds the re-stitch image fixtures deterministically (feature 030, T001).
 *
 * ffmpeg draws the pictures; EXIF orientation is written by hand as an APP1 segment, because
 * ffmpeg has no switch for it and the fixtures must not depend on exiftool being installed.
 * The pictures are 64×32 with the left half red and the right half blue, so a wrong rotation is
 * visible in a first-frame hash, not only in metadata.
 *
 * Usage: node tests/fixtures/restitch-images/make.mjs   (run from the repository root)
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
// Homebrew's ffmpeg ships without libwebp; the webp tools from `brew install webp` do the two
// WebP fixtures. Both are spawned without a shell.
const cwebp = process.env.CWEBP_PATH ?? 'cwebp';
const img2webp = process.env.IMG2WEBP_PATH ?? 'img2webp';

function run(args, command = ffmpeg) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('error', reject);
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${args.join(' ')}\n${stderr}`))
    );
  });
}

const SOURCE = 'color=c=red:s=32x32:d=1[l];color=c=blue:s=32x32:d=1[r];[l][r]hstack';

async function still(name, extra) {
  const target = path.join(here, name);
  await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', SOURCE, '-frames:v', '1', ...extra, target]);
  return target;
}

/** A minimal EXIF APP1 segment: TIFF header + one IFD with the Orientation tag. */
function exifSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'ascii'); // little-endian
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value (left-justified in the 4-byte slot)
  tiff.writeUInt16LE(0, 20);
  tiff.writeUInt32LE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

async function withOrientation(source, name, orientation) {
  const bytes = await readFile(source);
  if (bytes.readUInt16BE(0) !== 0xffd8) throw new Error(`${source} is not a JPEG`);
  const target = path.join(here, name);
  await writeFile(
    target,
    Buffer.concat([bytes.subarray(0, 2), exifSegment(orientation), bytes.subarray(2)])
  );
  return target;
}

async function animated(name, extra) {
  const target = path.join(here, name);
  await run([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=16x16:r=2:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=16x16:r=2:d=1',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0',
    ...extra,
    target
  ]);
  return target;
}

await mkdir(here, { recursive: true });
const made = {};
made['plain.png'] = await still('plain.png', ['-pix_fmt', 'rgb24']);
made['plain.jpg'] = await still('plain.jpg', ['-q:v', '2', '-pix_fmt', 'yuvj420p']);
made['plain.webp'] = path.join(here, 'plain.webp');
await run(['-quiet', '-lossless', made['plain.png'], '-o', made['plain.webp']], cwebp);
for (const orientation of [1, 3, 6, 8]) {
  made[`exif-${orientation}.jpg`] = await withOrientation(
    made['plain.jpg'],
    `exif-${orientation}.jpg`,
    orientation
  );
}
made['animated.gif'] = await animated('animated.gif', []);
{
  // Two frames, red then blue: enough for ffprobe to count more than one.
  const red = path.join(here, 'frame-red.png');
  const blue = path.join(here, 'frame-blue.png');
  await run([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=16x16:d=1',
    '-frames:v',
    '1',
    red
  ]);
  await run([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=16x16:d=1',
    '-frames:v',
    '1',
    blue
  ]);
  made['animated.webp'] = path.join(here, 'animated.webp');
  await run(['-loop', '0', '-d', '500', red, blue, '-o', made['animated.webp']], img2webp);
  await Promise.all(
    [red, blue].map(file => import('node:fs/promises').then(fs => fs.unlink(file)))
  );
}

const lines = [];
for (const [name, file] of Object.entries(made)) {
  const bytes = await readFile(file);
  lines.push(
    `  '${name}': { md5: '${createHash('md5').update(bytes).digest('hex')}', bytes: ${bytes.length} }`
  );
}
console.log(lines.join(',\n'));
