import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CASE_IDS } from './catalog.mjs';

/** Conservative impact closure: broad fallback includes every case, never silently excludes a file. */
export async function scopeInventory() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const candidateSha = git(['rev-parse', 'HEAD']).trim();
  const baseSha = git(['rev-parse', 'v1.2.6^{commit}']).trim();
  const changed = git(['diff', '--name-only', '-z', 'v1.2.6']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  const files = [];
  for (const file of [...new Set([...changed, ...untracked])].sort()) {
    let hash = null;
    try {
      hash = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    }
    const patterns = /tariff|recovery/.test(file)
      ? ['TARIFF-', 'LIFE-', 'ACL-', 'OBS-']
      : /launch/.test(file)
        ? ['LAUNCH-', 'ACL-', 'OBS-', 'REG-']
        : /finance|account/.test(file)
          ? ['REG-', 'TEAM-', 'ACL-', 'SYNC-', 'OBS-']
          : /analytics|diagnostic|journal/.test(file)
            ? ['OBS-', 'REG-', 'LIFE-']
            : /sync|catalog|drive|material/.test(file)
              ? ['SYNC-', 'REG-', 'ACL-', 'LIFE-', 'OBS-']
              : null;
    const cases = patterns
      ? CASE_IDS.filter(id => patterns.some(prefix => id.startsWith(prefix)))
      : [...CASE_IDS];
    files.push({
      path: file,
      sha256: hash,
      state: hash === null ? 'deleted' : untracked.includes(file) ? 'untracked' : 'changed',
      cases,
      gates: ['verify', 'verify:release'],
      mapping: patterns ? 'conservative-subsystem-closure' : 'full-regression-fallback'
    });
  }
  return {
    schemaVersion: 1,
    baseTag: 'v1.2.6',
    baseSha,
    candidateSha,
    dirty: git(['status', '--porcelain']).length > 0,
    generatedAt: new Date().toISOString(),
    launches: 'included',
    files,
    limits: [
      'Impact mapping is conservative scope, not execution evidence.',
      'Dirty source hashes must be frozen again before final acceptance.'
    ]
  };
}
