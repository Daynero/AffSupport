import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCandidate, validateFinal } from '../scripts/lib/release/gates.mjs';

const stable = {
  version: '1.0.0',
  signature: 'signature',
  artifacts: { 'macos-arm64': { sha256: 'a'.repeat(64) } }
};
const candidate = {
  sourceSha: 'b'.repeat(40),
  version: '1.1.0',
  targetDigest: 'c'.repeat(64),
  packageDigest: 'd'.repeat(64)
};

describe('candidate and final gates', () => {
  it('requires a trusted prior stable and exact beta package provenance', () => {
    expect(
      validateCandidate({
        candidate,
        previousStable: stable,
        betaEvidence: { sourceSha: candidate.sourceSha, packageDigest: candidate.packageDigest }
      }).ok
    ).toBe(true);
    expect(
      validateCandidate({
        candidate,
        previousStable: stable,
        betaEvidence: { sourceSha: 'old', packageDigest: candidate.packageDigest }
      })
    ).toMatchObject({ code: 'BETA_EVIDENCE_INVALID' });
  });
  it('rejects future and mismatched published hashes', () => {
    expect(
      validateFinal({
        manifest: {
          version: '1.1.0',
          signature: 'ok',
          artifacts: { 'macos-arm64': { sha256: 'b'.repeat(64) } }
        },
        publishedArtifacts: { 'macos-arm64': { sha256: 'a'.repeat(64) } },
        expectedVersion: '1.1.0'
      })
    ).toMatchObject({ ok: false });
  });
});

describe('phase-scoped release validation', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/verify-release.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8'
    });

  it('defaults to the final phase rather than the laxest one', () => {
    const source = readFileSync('scripts/verify-release.mjs', 'utf8');
    expect(source).toContain("env.SOTY_RELEASE_VERIFY_MODE ?? 'final'");
  });

  it('refuses an unknown mode before doing any work', () => {
    const result = run(['--mode=nonsense']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown release validation mode');
    // Rejected before the contract checks even ran.
    expect(result.stdout).toBe('');
  });

  it('refuses contradictory phase flags instead of picking one', () => {
    expect(run(['--package', '--deploy']).status).toBe(1);
    expect(run(['--mode=final', '--package']).stderr).toContain('contradicts');
  });

  it('leaves tag and worktree requirements to the phases they belong to', () => {
    // The worktree is dirty during ordinary development, and the contract phase
    // must still be answerable — it is what the aggregator runs on every pull
    // request. Asserting the absence of the later phases' requirements is a
    // statement about the split itself, and unlike "the repository is green" it
    // does not depend on what happens to be built in apps/web/dist.
    const result = run(['--mode=contract']);
    const output = `${result.stdout}${result.stderr}`;
    for (const candidateOrFinalOnly of [
      'publishing requires a clean, committed worktree',
      'already exists locally and cannot be rebuilt',
      'must exist locally before web deployment',
      'is not an ancestor of the web deployment commit'
    ]) {
      expect(output).not.toContain(candidateOrFinalOnly);
    }
    // Whatever it concluded, it concluded it about the contract phase.
    if (result.status === 0) expect(result.stdout).toContain('passed contract validation');
  });

  it('keeps the release commands on the stricter phases', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['package:mac']).toContain('verify-release.mjs --mode=candidate');
    expect(scripts['package:dmg']).toContain('verify-release.mjs --mode=candidate');
    for (const command of ['deploy:web', 'deploy:web:identity', 'deploy:web:member-pilot']) {
      expect(scripts[command]).toContain('verify-release.mjs --mode=final');
    }
    // No production command may reach a deploy through the contract phase.
    for (const [name, command] of Object.entries(scripts as Record<string, string>)) {
      if (!command.includes('pages deploy') && !command.includes('deploy-web.mjs')) continue;
      expect(`${name}:${command.includes('--mode=final')}`).toBe(`${name}:true`);
    }
  });

  it('lets a release runner carry its phase through the aggregator', () => {
    const source = readFileSync('scripts/verify-all.mjs', 'utf8');
    expect(source).toContain("`--mode=${process.env.SOTY_RELEASE_VERIFY_MODE ?? 'contract'}`");
  });
});
