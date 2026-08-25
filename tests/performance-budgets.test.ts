import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { describeRequiring, requirePath } from './support/requires.js';

/**
 * A budget for what the browser has to download before anything works.
 *
 * Ratcheted rather than fixed, for the same reason coverage is: an absolute
 * target invented now would either be met on the day it was written and never
 * again, or missed on the day it was written and ignored forever. What this
 * catches is the ordinary way a bundle grows — a library added for one screen
 * and paid for on every screen, by everyone, on every visit.
 *
 * Sizes are gzipped, because that is what actually crosses the wire, and a
 * comparison in raw bytes would swing on whitespace.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(root, 'apps/web/dist/assets');
const BASELINE = path.join(root, 'performance-baseline.json');

/**
 * How far the total may drift before this fails.
 *
 * Not zero: a dependency's own patch release moves it by a kilobyte or two, and
 * a budget that fires on noise is one people learn to raise rather than respect.
 */
const TOLERANCE_PERCENT = 5;

interface Baseline {
  measured_at: string;
  total_gzip_bytes: number;
  entry_gzip_bytes: number;
  largest_gzip_bytes: number;
}

/** Gzipped size of every built asset, plus the entry the document loads first. */
function measure() {
  const files = readdirSync(ASSETS).filter(name => /\.(?:js|css)$/u.test(name));
  let total = 0;
  let largest = 0;
  let entry = 0;
  for (const name of files) {
    const file = path.join(ASSETS, name);
    if (!statSync(file).isFile()) continue;
    const size = gzipSync(readFileSync(file)).length;
    total += size;
    largest = Math.max(largest, size);
    // The entry chunk is the one Vite names `index-*.js`: it is what runs
    // before anything can be lazily loaded, so it is the number that decides
    // how long the first screen takes.
    if (/^index-.*\.js$/u.test(name)) entry = Math.max(entry, size);
  }
  return { total, largest, entry, count: files.length };
}

describeRequiring(requirePath('apps/web/dist/assets'), 'download budget', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

  it('measures something', () => {
    // A guard on the guard: an empty asset directory would make every
    // comparison below pass while measuring nothing.
    const measured = measure();
    expect(measured.count).toBeGreaterThan(3);
    expect(measured.total).toBeGreaterThan(50_000);
  });

  it('has not grown beyond tolerance in total', () => {
    const measured = measure();
    const ceiling = Math.round(baseline.total_gzip_bytes * (1 + TOLERANCE_PERCENT / 100));
    expect(
      measured.total,
      `total gzipped assets grew from ${baseline.total_gzip_bytes} to ${measured.total} bytes`
    ).toBeLessThanOrEqual(ceiling);
  });

  it('has not grown the entry chunk beyond tolerance', () => {
    const measured = measure();
    const ceiling = Math.round(baseline.entry_gzip_bytes * (1 + TOLERANCE_PERCENT / 100));
    // The entry is what runs before any lazy chunk can, so it is the number
    // that decides how long the first screen takes on a slow connection.
    expect(
      measured.entry,
      `entry chunk grew from ${baseline.entry_gzip_bytes} to ${measured.entry} bytes`
    ).toBeLessThanOrEqual(ceiling);
  });

  it('has not grown the largest single chunk beyond tolerance', () => {
    const measured = measure();
    const ceiling = Math.round(baseline.largest_gzip_bytes * (1 + TOLERANCE_PERCENT / 100));
    expect(
      measured.largest,
      `largest chunk grew from ${baseline.largest_gzip_bytes} to ${measured.largest} bytes`
    ).toBeLessThanOrEqual(ceiling);
  });
});
