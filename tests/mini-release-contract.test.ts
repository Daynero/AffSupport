import { describe, expect, it } from 'vitest';
import {
  webOnlyMode,
  webOnlyBackendPlan,
  WEB_ONLY_CHECKS,
  assertNoPendingPublication,
  assertUploadProcessGone
} from '../scripts/release-web-only.mjs';
import { validateWebOnlyProof } from '../scripts/lib/web-only-proof.mjs';
import {
  assertWebReleaseResources,
  boundedWebEnvironment
} from '../scripts/lib/web-only-resources.mjs';

// The original schema-v2/full-runner fixtures belong to the deferred 82-task scope.
// The owner selected a strict web-only MVP that preserves the existing runner.
const now = Date.parse('2026-10-25T17:00:00Z');
const inputs = {
  sourceSha: 'a'.repeat(40),
  agentSha: 'b'.repeat(40),
  agentInputsDigest: 'c'.repeat(64),
  bindingDigest: 'd'.repeat(64),
  configurationDigest: 'e'.repeat(64),
  manifestDigest: 'f'.repeat(64),
  productionBundleDigest: '1'.repeat(64),
  betaBundleDigest: '2'.repeat(64),
  packageDigest: '3'.repeat(64),
  packageSourceSha: '4'.repeat(40),
  packageBaselineDigest: '5'.repeat(64)
};
const proof = {
  ...inputs,
  schemaVersion: 1,
  kind: 'web-only',
  runId: '22222222-2222-4222-8222-222222222222',
  webBuildId: `web:${inputs.sourceSha}:${inputs.configurationDigest.slice(0, 12)}`,
  verifiedAt: new Date(now).toISOString(),
  checks: Object.fromEntries(WEB_ONLY_CHECKS.map(check => [check, 'passed']))
};

describe('web-only MVP command and immutable proof', () => {
  it('defaults to read-only eligibility instead of publication', () => {
    expect(webOnlyMode([])).toBe('check');
    expect(webOnlyMode(['--json'])).toBe('check');
  });
  it.each(['check', 'verify-only', 'deploy', 'report', 'reconcile', 'plan-db', 'reconcile-db'])(
    'accepts explicit %s mode',
    mode => {
      expect(webOnlyMode([`--${mode}`])).toBe(mode);
    }
  );
  it('carries one explicit DB plan only into candidate checking or publishing', () => {
    for (const mode of ['check', 'verify-only', 'deploy']) {
      expect(webOnlyMode([`--${mode}`, '--backend-plan=private/draft.json'])).toBe(mode);
      expect(webOnlyBackendPlan(['--backend-plan=private/draft.json'])).toBe('private/draft.json');
    }
    for (const args of [
      ['--backend-plan='],
      ['--backend-plan=a', '--backend-plan=b'],
      ...['report', 'reconcile', 'plan-db', 'reconcile-db'].map(mode => [
        `--${mode}`,
        '--backend-plan=a'
      ])
    ])
      expect(() => webOnlyMode(args)).toThrow('WEB_ONLY_ARGUMENT_INVALID');
  });
  it.each([['--skip-beta'], ['--build-agent'], ['--deploy', '--check'], ['--deploy', '--deploy']])(
    'refuses unsafe/ambiguous arguments %j',
    (...args) => {
      expect(() => webOnlyMode(args)).toThrow('WEB_ONLY_ARGUMENT_INVALID');
    }
  );
  it('accepts only a fresh proof for all exact inputs and required checks', () => {
    expect(validateWebOnlyProof(proof, inputs, now)).toBe(proof);
  });
  it.each(Object.keys(inputs))('rejects changed %s before publication', field => {
    expect(() => validateWebOnlyProof(proof, { ...inputs, [field]: '9'.repeat(64) }, now)).toThrow(
      'WEB_ONLY_PROOF_MISMATCH'
    );
  });
  it.each(WEB_ONLY_CHECKS)('requires actual %s evidence', check => {
    expect(() =>
      validateWebOnlyProof(
        { ...proof, checks: { ...proof.checks, [check]: 'not_run' } },
        inputs,
        now
      )
    ).toThrow('WEB_ONLY_CHECK_UNPROVEN');
  });
  it('does not relabel the legacy packaged-beta record as a web candidate proof', () => {
    expect(() =>
      validateWebOnlyProof(
        {
          sourceRevision: inputs.sourceSha,
          dirty: false,
          packageDigest: inputs.packageDigest,
          verifiedAt: proof.verifiedAt
        },
        inputs,
        now
      )
    ).toThrow('WEB_ONLY_PROOF_EXPIRED_OR_INVALID');
  });
  it.each([now - 31 * 60_000, now + 61_000, NaN])(
    'rejects expired/future/invalid proof timestamp %s',
    timestamp => {
      expect(() =>
        validateWebOnlyProof(
          {
            ...proof,
            verifiedAt: Number.isNaN(timestamp) ? 'invalid' : new Date(timestamp).toISOString()
          },
          inputs,
          now
        )
      ).toThrow('WEB_ONLY_PROOF_EXPIRED_OR_INVALID');
    }
  );
  it('rejects an arbitrary record ID and a relabelled web build', () => {
    expect(() => validateWebOnlyProof({ ...proof, runId: '-'.repeat(36) }, inputs, now)).toThrow();
    expect(() => validateWebOnlyProof({ ...proof, webBuildId: '1.2.7' }, inputs, now)).toThrow(
      'IDENTITY'
    );
  });
});

describe('web-only host resource boundary', () => {
  const safe = { diskFreeBytes: 6 * 1024 ** 3, memoryFreePercent: 40, load: 8, cores: 8 };
  it('admits a bounded single-worker job with measured headroom', () => {
    expect(() => assertWebReleaseResources(safe)).not.toThrow();
  });
  it.each([
    ['disk', { diskFreeBytes: 2 * 1024 ** 3 }, 'DISK'],
    ['memory', { memoryFreePercent: 10 }, 'MEMORY'],
    ['CPU', { load: 17 }, 'CPU'],
    ['unknown', { memoryFreePercent: NaN }, 'UNKNOWN']
  ] as const)('waits before work when %s is exhausted', (_name, patch, code) => {
    expect(() => assertWebReleaseResources({ ...safe, ...patch })).toThrow(code);
  });
  it('bounds heap and native thread pools without dropping caller configuration', () => {
    const env = boundedWebEnvironment({ NODE_OPTIONS: '--trace-warnings', LANG: 'en_GB.UTF-8' });
    expect(env.NODE_OPTIONS).toBe('--trace-warnings --max-old-space-size=1024');
    expect(env.GOMAXPROCS).toBe('2');
    expect(env.UV_THREADPOOL_SIZE).toBe('2');
    expect(env.LANG).toBe('en_GB.UTF-8');
  });
});

describe('unknown publication outcome', () => {
  it('prevents overwriting unresolved publication evidence on retry', () => {
    expect(() => assertNoPendingPublication(null)).not.toThrow();
    expect(() =>
      assertNoPendingPublication({ runId: 'prior', publicationState: 'unknown' })
    ).toThrow('PUBLICATION_UNRESOLVED');
  });
  it('never assumes an unrecorded upload process is gone', () => {
    expect(() => assertUploadProcessGone({})).toThrow('QUIESCENCE_UNPROVEN');
    expect(() => assertUploadProcessGone({ uploadProcess: { pid: 1 } })).toThrow(
      'QUIESCENCE_UNPROVEN'
    );
  });
});
