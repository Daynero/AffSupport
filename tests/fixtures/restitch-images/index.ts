/**
 * The re-stitch image fixtures (feature 030), made by `make.mjs` next to this file.
 *
 * Every picture is 64×32, red on the left and blue on the right, so a wrong rotation shows up
 * in pixels and not only in metadata. The EXIF variants are the same JPEG with an APP1
 * segment prepended; the two animated ones exist to be refused.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTITCH_FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type RestitchFixtureName = keyof typeof RESTITCH_FIXTURES;

export const RESTITCH_FIXTURES = {
  'plain.png': {
    md5: 'e73a4033664c008b847a26cae2d349c6',
    bytes: 147,
    mimeType: 'image/png',
    orientation: 1,
    animated: false
  },
  'plain.jpg': {
    md5: 'a054b010febb2d4cdadeeca6d42e6918',
    bytes: 246,
    mimeType: 'image/jpeg',
    orientation: 1,
    animated: false
  },
  'plain.webp': {
    md5: '367b9a319626ee3593d4954223681317',
    bytes: 46,
    mimeType: 'image/webp',
    orientation: 1,
    animated: false
  },
  'exif-1.jpg': {
    md5: '4322a95a4f8ebccac1419f722a07737d',
    bytes: 282,
    mimeType: 'image/jpeg',
    orientation: 1,
    animated: false
  },
  'exif-3.jpg': {
    md5: 'c16295556eeefb1ef0c7a8ac426ed311',
    bytes: 282,
    mimeType: 'image/jpeg',
    orientation: 3,
    animated: false
  },
  'exif-6.jpg': {
    md5: 'f86fb3dc982e3383e18611872d362d6a',
    bytes: 282,
    mimeType: 'image/jpeg',
    orientation: 6,
    animated: false
  },
  'exif-8.jpg': {
    md5: '356d763a75eab3da06d3a21a22c9d66c',
    bytes: 282,
    mimeType: 'image/jpeg',
    orientation: 8,
    animated: false
  },
  'animated.gif': {
    md5: '0fb9eaa5337b76c2709226b4f2b354d6',
    bytes: 972,
    mimeType: 'image/gif',
    orientation: 1,
    animated: true
  },
  'animated.webp': {
    md5: '9732f4c157dad67817c781102551914b',
    bytes: 140,
    mimeType: 'image/webp',
    orientation: 1,
    animated: true
  }
} as const;

export function restitchFixturePath(name: RestitchFixtureName): string {
  return path.join(RESTITCH_FIXTURE_DIR, name);
}
