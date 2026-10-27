import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { describeRequiring, requirePath } from './support/requires.js';
import { exclusiveLazyRouteAssets, sumAssetBytes } from '../scripts/lib/lazy-route-assets.mjs';

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
const DIST = path.join(root, 'apps/web/dist');
const MANIFEST = path.join(DIST, '.vite/manifest.json');
const ACCOUNTS_BEFORE = path.join(
  root,
  'specs/038-unified-accounts/reviews/bundle-budget-baseline.json'
);
const FEATURE_045_COMPARISON = path.join(
  root,
  'specs/045-catalog-r2-images/bundle-budget-comparison.json'
);
const ACCOUNT_ROUTE = 'src/team/accounts/AccountSpace.tsx';
const LAUNCH_ROUTE = 'src/team/launches/LaunchSpace.tsx';
// Explicit feature 038 allowance: unified finance/runs, archive and library drag
// interactions are downloaded only upon entering Accounts. This revises route
// budget accounting; it does not claim the complete application became smaller.
const ACCOUNTS_INCREMENTAL_ALLOWANCE = 55_000;
const ACCOUNTS_EXCLUSIVE_CEILING = 80_000;
const LAUNCH_ROOT_CEILING = 20_000;
// Owner-approved 045 allocation: the clean b0c0077b base already measures
// 44,680 B for Launch; this feature measures 44,649 B. The R2 feature's
// shared/existing increase is separately capped against that measured base.
const LAUNCH_EXCLUSIVE_CEILING = 45_000;
const FEATURE_045_INCREMENTAL_ALLOWANCE = 20_000;

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

interface AccountsBefore {
  source_sha: string;
  manifest: unknown;
  assets: Array<{ file: string; gzip_bytes: number; sha256: string }>;
  accounts: {
    source: string;
    exclusive_gzip_bytes: number;
    files: Array<{ file: string; gzip_bytes: number; sha256: string }>;
  };
}
interface Feature045Comparison {
  source_sha: string;
  authorization: {
    shared_existing_incremental_allowance: number;
    launch_exclusive_ceiling: number;
  };
  base_oxc: {
    launch_exclusive_gzip: number;
    shared_existing_gzip: number;
  };
}

/** Gzipped size of every built asset, plus the entry the document loads first. */
function measure() {
  const files = readdirSync(ASSETS).filter(name => /\.(?:js|css)$/u.test(name));
  let total = 0;
  let largest = 0;
  let entry = 0;
  let lazyLaunch = 0;
  let lazyLaunchChunks = 0;
  for (const name of files) {
    const file = path.join(ASSETS, name);
    if (!statSync(file).isFile()) continue;
    const size = gzipSync(readFileSync(file)).length;
    total += size;
    largest = Math.max(largest, size);
    if (/^LaunchSpace-.*\.js$/u.test(name)) {
      lazyLaunch += size;
      lazyLaunchChunks++;
    }
    // The entry chunk is the one Vite names `index-*.js`: it is what runs
    // before anything can be lazily loaded, so it is the number that decides
    // how long the first screen takes.
    if (/^index-.*\.js$/u.test(name)) entry = Math.max(entry, size);
  }
  return { total, largest, entry, lazyLaunch, lazyLaunchChunks, count: files.length };
}

describeRequiring(
  requirePath('apps/web/dist/assets', MANIFEST, ACCOUNTS_BEFORE, FEATURE_045_COMPARISON),
  'download budget',
  () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

    it('measures something', () => {
      // A guard on the guard: an empty asset directory would make every
      // comparison below pass while measuring nothing.
      const measured = measure();
      expect(measured.count).toBeGreaterThan(3);
      expect(measured.total).toBeGreaterThan(50_000);
    });

    it('preserves ratchets with the explicit bounded 045 allocation and complete route graphs', () => {
      const measured = measure();
      const ceiling = Math.round(baseline.total_gzip_bytes * (1 + TOLERANCE_PERCENT / 100));
      const manifest: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
      const accounts = exclusiveLazyRouteAssets(manifest, ACCOUNT_ROUTE);
      const launches = exclusiveLazyRouteAssets(manifest, LAUNCH_ROUTE);
      const sizeOf = (file: string) => gzipSync(readFileSync(path.join(DIST, file))).length;
      const accountBytes = sumAssetBytes(accounts.files, sizeOf);
      const launchBytes = sumAssetBytes(launches.files, sizeOf);
      const before = JSON.parse(readFileSync(ACCOUNTS_BEFORE, 'utf8')) as AccountsBefore;
      const feature045 = JSON.parse(
        readFileSync(FEATURE_045_COMPARISON, 'utf8')
      ) as Feature045Comparison;
      expect(feature045.source_sha).toBe('b0c0077b6b95f43f54daa32912052e2e7a7e953a');
      expect(feature045.authorization.shared_existing_incremental_allowance).toBe(
        FEATURE_045_INCREMENTAL_ALLOWANCE
      );
      expect(feature045.authorization.launch_exclusive_ceiling).toBe(LAUNCH_EXCLUSIVE_CEILING);
      expect(feature045.base_oxc.launch_exclusive_gzip).toBe(44_680);
      expect(feature045.base_oxc.shared_existing_gzip).toBe(998_034);
      const beforeGraph = exclusiveLazyRouteAssets(before.manifest, ACCOUNT_ROUTE);
      expect(before.source_sha).toBe('4c392f6316a0a6ad1f02e4acc0b30bb1df91e10b');
      expect(before.accounts.source).toBe(ACCOUNT_ROUTE);
      expect(before.accounts.files.length).toBeGreaterThan(0);
      expect(new Set(before.accounts.files.map(file => file.file)).size).toBe(
        before.accounts.files.length
      );
      expect(before.accounts.files.map(file => file.file).sort()).toEqual(beforeGraph.files);
      for (const file of before.accounts.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(Number.isSafeInteger(file.gzip_bytes) && file.gzip_bytes > 0).toBe(true);
        expect(before.assets.filter(asset => asset.file === file.file)).toEqual([file]);
      }
      expect(before.accounts.exclusive_gzip_bytes).toBe(
        before.accounts.files.reduce((sum, file) => sum + file.gzip_bytes, 0)
      );
      // Only the growth of the COMPLETE exclusive Accounts graph is exempted.
      // Its complete pre038 cost remains charged globally, including old private
      // dependencies. Shared dependencies, orphan assets and all other routes
      // remain charged in full. 045 adds only the explicit owner-approved
      // allowance below; the old baseline and its 5% tolerance remain fixed.
      const accountsIncrement = Math.max(0, accountBytes - before.accounts.exclusive_gzip_bytes);
      const existingBytes = measured.total - launchBytes - accountsIncrement;
      expect(accounts.files.filter(file => launches.files.includes(file))).toEqual([]);
      expect(measured.lazyLaunchChunks).toBe(1);
      expect(measured.lazyLaunch).toBe(sizeOf(launches.rootFile));
      expect(measured.lazyLaunch).toBeLessThanOrEqual(LAUNCH_ROOT_CEILING);
      expect(launchBytes).toBeLessThanOrEqual(LAUNCH_EXCLUSIVE_CEILING);
      expect(accountBytes).toBeLessThanOrEqual(ACCOUNTS_EXCLUSIVE_CEILING);
      expect(accountsIncrement).toBeLessThanOrEqual(ACCOUNTS_INCREMENTAL_ALLOWANCE);
      const feature045Increment = Math.max(
        0,
        existingBytes - feature045.base_oxc.shared_existing_gzip
      );
      expect(
        feature045Increment,
        `shared/existing growth from clean 045 base: ${feature045Increment}B; owner-approved allocation ${FEATURE_045_INCREMENTAL_ALLOWANCE}B`
      ).toBeLessThanOrEqual(FEATURE_045_INCREMENTAL_ALLOWANCE);
      expect(
        existingBytes,
        `shared/existing assets: ${existingBytes}B; total ${measured.total}B minus Launch graph ${launchBytes}B and explicit038increment ${accountsIncrement}B; pre038 Accounts graph ${before.accounts.exclusive_gzip_bytes}B remains charged; original ratchet ${ceiling}B plus explicit045 allocation ${FEATURE_045_INCREMENTAL_ALLOWANCE}B`
      ).toBeLessThanOrEqual(ceiling + FEATURE_045_INCREMENTAL_ALLOWANCE);
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
  }
);
