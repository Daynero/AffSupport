import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

// These are identities of implemented local fixtures, not generic words such
// as "clock" or "capture" that also belong to production features. New fixture
// adapters must extend this inventory before they can be accepted.
/** @type {readonly (readonly [string, RegExp])[]} */
const MARKERS = [
  ['tariff-clock-overlay', /\bacceptance_tariff_clock\b/iu],
  ['diagnostic-capture', /soty\.acceptance\.capture\.v1/u],
  ['mail-capture', /soty\.acceptance\.mail-capture\.v1/u],
  [
    'scoped-faults',
    /soty\.acceptance\.(?:faults|worker-checkpoint)\.v1|\b(?:acceptance_scoped_faults|createLocalFaultAdapter|executeResponseFault|executeProviderFault|executeDeliveryFault|changeLocalFaultJournal|mutateFaultJournal|spawnCheckpointFixture|crashOwnedCheckpointFixture|restartCheckpointFixture|ACCEPTANCE_RESPONSE_LOST)\b/u
  ]
];

/**
 * A source/artifact containment guard, not a claim about a running database.
 * The legitimate real-time private.tariff_now seam belongs in migrations;
 * its local replacement and synthetic capture activation do not.
 * Returns names/codes only: file contents may include credentials.
 * @param {{root?: string, productionArtifacts?: boolean}} options
 */
export function scanAcceptanceIsolation({ root = process.cwd(), productionArtifacts = true } = {}) {
  /** @type {{code: string, file: string, marker?: string}[]} */
  const problems = [];
  let scannedFiles = 0;
  let builtWebPresent = false;
  function scan(relative, required, directoryExpected = false) {
    const absolute = path.join(root, relative);
    let stat;
    let readable = absolute;
    try {
      // lstat on the leaf still follows symlinks in its parents. Check every
      // ancestor below the selected repository before reading any input bytes.
      const segments = relative.split('/');
      for (let index = 1; index < segments.length; index++) {
        const parent = lstatSync(path.join(root, ...segments.slice(0, index)));
        if (parent.isSymbolicLink() || !parent.isDirectory()) {
          problems.push({ code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH', file: relative });
          return;
        }
      }
      stat = lstatSync(absolute);
      // Existing local Supabase setup aliases only .env -> .env.local. Inspect
      // that exact regular sibling, never resolve an arbitrary link/chain.
      if (
        stat.isSymbolicLink() &&
        relative === 'supabase/functions/.env' &&
        readlinkSync(absolute) === '.env.local'
      ) {
        readable = path.join(root, 'supabase/functions/.env.local');
        stat = lstatSync(readable);
        if (!stat.isFile()) {
          problems.push({ code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH', file: relative });
          return;
        }
      }
    } catch (error) {
      if (
        !required &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return;
      problems.push({ code: 'ACCEPTANCE_ISOLATION_UNREADABLE', file: relative });
      return;
    }
    // Never follow a link to some other tree and report that this tree passed.
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (directoryExpected && !stat.isDirectory())
    ) {
      problems.push({ code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH', file: relative });
      return;
    }
    if (relative === 'apps/web/dist') builtWebPresent = true;
    if (stat.isDirectory()) {
      try {
        for (const entry of readdirSync(absolute).sort())
          scan(path.posix.join(relative, entry), true);
      } catch {
        problems.push({ code: 'ACCEPTANCE_ISOLATION_UNREADABLE', file: relative });
      }
      return;
    }
    // Source SQL/functions/config and executable web assets; images/fonts do
    // not activate either fixture. Source maps are included as shipped bytes.
    if (
      !/\.(?:sql|[cm]?[jt]sx?|json|html|map|env)$/iu.test(relative) &&
      !path.basename(relative).startsWith('.env')
    )
      return;
    try {
      const contents = readFileSync(readable, 'utf8');
      scannedFiles++;
      for (const [marker, expression] of MARKERS) {
        if (expression.test(contents))
          problems.push({ code: 'ACCEPTANCE_FIXTURE_IN_RELEASE', file: relative, marker });
      }
    } catch {
      problems.push({ code: 'ACCEPTANCE_ISOLATION_UNREADABLE', file: relative });
    }
  }
  scan('supabase/migrations', true, true);
  scan('supabase/functions', true, true);
  scan('apps/agent/src', false, true);
  if (productionArtifacts) {
    for (const file of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
      'apps/web/.env.production',
      'config/production.env'
    ])
      scan(file, false);
    scan('apps/web/dist', false, true);
    scan('apps/agent/dist', false, true);
  }
  return { ok: problems.length === 0, scannedFiles, builtWebPresent, problems };
}
