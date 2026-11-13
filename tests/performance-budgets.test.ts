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
const FEATURE_053_COMPARISON = path.join(
  root,
  'specs/053-bulk-launches/reviews/bundle-budget-comparison.json'
);
const BATCH_ROUTE = 'src/team/launches/LaunchBatch.tsx';
const ACCOUNT_ROUTE = 'src/team/accounts/AccountSpace.tsx';
const LAUNCH_ROUTE = 'src/team/launches/LaunchSpace.tsx';
// Explicit feature 038 allowance: unified finance/runs, archive and library drag
// interactions are downloaded only upon entering Accounts. This revises route
// budget accounting; it does not claim the complete application became smaller.
const ACCOUNTS_INCREMENTAL_ALLOWANCE = 56_000;
// Owner approved 2026-11-09 for 049 installer choice (measured 80 009).
const ACCOUNTS_EXCLUSIVE_CEILING = 81_000;
const LAUNCH_ROOT_CEILING = 20_000;
// Owner-approved 1.3.0 route allowances. The root chunk and global download
// ratchets remain unchanged; historical 1.2.10 evidence retains its original cap.
// Owner approved 2026-11-09 for 047+049: +2 000 for Launch reliability (measured 50 447).
// Owner approved 2026-11-10 for 1.4.1: the catalog video fields and publication status
// ship in production instead of a beta-only chunk (measured 52 389).
const LAUNCH_EXCLUSIVE_CEILING = 54_000;
// 053 implementation scope: exact detached 1.4.4 base measured 54,291 B Launch
// and 1,081,860 B shared/existing (already +17,072 B above the older global cap).
// Keep that existing growth distinct from this feature's bounded contribution.
// Evidence, identical lockfiles and complete lazy graphs are archived in 053.
// Entry, largest chunk, Accounts, root Launch and the original baseline stay fixed.
const RELEASE_144_EXISTING_ALLOWANCE = 18_000;
// Owner-requested durable server batches, automatic setup, compact settings and
// canonical rename supersede the browser-local follow-up scope. Measured growth
// is 11,445 B Launch and 9,296 B shared against the same exact release base.
// Allocate at most 12 kB Launch and 10 kB shared for the complete feature; all
// descendants, including the activation-only rename dialog, remain charged.
// Root/entry/largest/Accounts and the original baseline ratchets stay unchanged.
const FEATURE_053_LAUNCH_ALLOWANCE = 12_500;
const FEATURE_053_LAUNCH_INCREMENT_CEILING = 12_000;
const FEATURE_053_SHARED_ALLOWANCE = 10_000;
// Integrated 1.2.10 includes the completed R2 library, quota and schedule UI;
// measured shared growth is 30,145 B against the unchanged clean 045 base.
const FEATURE_045_INCREMENTAL_ALLOWANCE = 32_000;
// Owner approved for 1.3.0: relative growth only, without increasing the global cap.
// Owner approved 2026-11-09 for 047+049 (measured 61 022 integrated): relative growth only.
// Owner approved 2026-11-10 for 1.4.1: catalog video variants and deferred publication
// are in the production bundle, no longer tree-shaken behind a beta flag (measured 65 454).
const RELEASE_130_SHARED_GROWTH_CEILING = 67_000;
// Owner approved 2026-11-09: global ratchet allowance for 047+049 (measured +22 268 B).
// Owner approved 2026-11-10 for 1.4.1: the same features now ship in production
// (measured +26 700 B against the original ratchet plus the 045 allocation).
const RELEASE_047_049_ALLOWANCE = 28_000;

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
  integration_1_2_10: { shared_existing_incremental_allowance: number };
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
  requirePath(
    'apps/web/dist/assets',
    MANIFEST,
    ACCOUNTS_BEFORE,
    FEATURE_045_COMPARISON,
    FEATURE_053_COMPARISON
  ),
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
      expect(feature045.authorization.shared_existing_incremental_allowance).toBe(20_000);
      expect(feature045.integration_1_2_10.shared_existing_incremental_allowance).toBe(
        FEATURE_045_INCREMENTAL_ALLOWANCE
      );
      expect(feature045.authorization.launch_exclusive_ceiling).toBe(48_000);
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
      expect(launchBytes).toBeLessThanOrEqual(
        LAUNCH_EXCLUSIVE_CEILING + FEATURE_053_LAUNCH_ALLOWANCE
      );
      const feature053 = JSON.parse(readFileSync(FEATURE_053_COMPARISON, 'utf8')) as {
        base_source: string;
        baseline: {
          launch_exclusive_gzip: number;
          shared_existing_gzip: number;
          lockfile_sha256: string;
        };
        feature: { lockfile_sha256: string };
      };
      expect(feature053.base_source).toBe('2d616995');
      expect(feature053.baseline.launch_exclusive_gzip).toBe(54_291);
      expect(feature053.baseline.shared_existing_gzip).toBe(1_081_860);
      expect(feature053.baseline.lockfile_sha256).toBe(feature053.feature.lockfile_sha256);
      expect(
        Math.max(0, launchBytes - feature053.baseline.launch_exclusive_gzip)
      ).toBeLessThanOrEqual(FEATURE_053_LAUNCH_INCREMENT_CEILING);
      expect(
        Math.max(0, existingBytes - feature053.baseline.shared_existing_gzip)
      ).toBeLessThanOrEqual(FEATURE_053_SHARED_ALLOWANCE);
      if (
        typeof manifest !== 'object' ||
        !manifest ||
        !(BATCH_ROUTE in manifest) ||
        !(LAUNCH_ROUTE in manifest)
      )
        throw new Error('Batch lazy route missing');
      expect(manifest[BATCH_ROUTE]).toMatchObject({ isDynamicEntry: true });
      expect(manifest[LAUNCH_ROUTE]).toMatchObject({
        dynamicImports: expect.arrayContaining([BATCH_ROUTE])
      });
      expect(accountBytes).toBeLessThanOrEqual(ACCOUNTS_EXCLUSIVE_CEILING);
      expect(accountsIncrement).toBeLessThanOrEqual(ACCOUNTS_INCREMENTAL_ALLOWANCE);
      const feature045Increment = Math.max(
        0,
        existingBytes - feature045.base_oxc.shared_existing_gzip
      );
      expect(
        feature045Increment,
        `shared/existing growth from clean 045 base: ${feature045Increment}B; 1.3.0 relative cap ${RELEASE_130_SHARED_GROWTH_CEILING}B plus measured 1.4.4 ${RELEASE_144_EXISTING_ALLOWANCE}B and 053 ${FEATURE_053_SHARED_ALLOWANCE}B`
      ).toBeLessThanOrEqual(
        RELEASE_130_SHARED_GROWTH_CEILING +
          RELEASE_144_EXISTING_ALLOWANCE +
          FEATURE_053_SHARED_ALLOWANCE
      );
      expect(
        existingBytes,
        `shared/existing assets: ${existingBytes}B; total ${measured.total}B minus Launch graph ${launchBytes}B and explicit038increment ${accountsIncrement}B; pre038 Accounts graph ${before.accounts.exclusive_gzip_bytes}B remains charged; original ratchet ${ceiling}B plus explicit045 allocation ${FEATURE_045_INCREMENTAL_ALLOWANCE}B`
      ).toBeLessThanOrEqual(
        ceiling +
          FEATURE_045_INCREMENTAL_ALLOWANCE +
          RELEASE_047_049_ALLOWANCE +
          RELEASE_144_EXISTING_ALLOWANCE +
          FEATURE_053_SHARED_ALLOWANCE
      );
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
