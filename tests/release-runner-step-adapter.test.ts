import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStepAdapter } from '../scripts/lib/release/step-adapter.mjs';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';

const binding = { bindingId: 'sandbox-local', kind: 'sandbox' };
const sourceSha = 'a'.repeat(40);

/**
 * A fake project: `npm`, `gh` and the scripts the adapter calls are replaced by
 * tiny executables on PATH that record what they were asked to do. The adapter
 * therefore runs its real command sequence without building or publishing
 * anything.
 */
async function fakeProject() {
  const root = await mkdtemp(join(tmpdir(), 'release-step-adapter-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  for (const name of ['npm', 'gh']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\nexit 0\n`);
    await chmod(join(bin, name), 0o755);
  }
  // The adapter invokes repository scripts by absolute node path; stand-ins with
  // the same relative names keep the sequence honest without running the real
  // gates.
  for (const script of [
    'verify-web-env.mjs',
    'verify-production-config.mjs',
    'verify-beta-promotion.mjs',
    'verify-published-release.mjs',
    'sign-release-manifest.mjs',
    'watch-github-run.mjs'
  ]) {
    // `.mjs` stand-ins must be ES modules, exactly like the scripts they replace.
    await writeFile(
      join(root, 'scripts', script),
      `import { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(${JSON.stringify(log)}, 'node ${script} ' + process.argv.slice(2).join(' ') + '\\n');\n`
    );
  }
  return { root, bin, log };
}

describe('the step adapter runs the runbook', () => {
  it('has an executor for every registry step', async () => {
    const { root, bin } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      for (const stepId of STEP_IDS) {
        const result = await adapter.execute(stepId);
        // Remote steps are refused by configuration, not missing; every other
        // step must have something real behind it.
        expect(`${stepId}:${result.ok || result.error.code === 'ACCESS_UNAVAILABLE'}`).toBe(
          `${stepId}:true`
        );
        expect(`${stepId}:${result.error?.code ?? 'ok'}`).not.toContain('no adapter for');
      }
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 60_000);

  it('touches nothing outside this machine when remote access is disallowed', async () => {
    const { root, bin } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      for (const stepId of ['publish', 'manifest', 'backend_apply', 'deploy']) {
        expect(await adapter.execute(stepId)).toMatchObject({
          ok: false,
          error: { code: 'ACCESS_UNAVAILABLE' }
        });
      }
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 30_000);

  it('runs the commands the production runbook names, in its order', async () => {
    const { root, bin, log } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      for (const stepId of ['candidate_gate', 'beta_package', 'beta_verify', 'macos_package']) {
        expect(await adapter.execute(stepId)).toMatchObject({ ok: true });
      }
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('npm run release:check');
      expect(calls).toContain('npm run beta:package');
      expect(calls).toContain('npm run beta:verify');
      expect(calls).toContain('npm run package:mac');
      expect(calls).toContain('npm run package:dmg');
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 60_000);

  it('asks the live project whether it can run this release, and says which migrations are planned', async () => {
    // The gap this closes: every earlier preflight check could pass on a
    // machine whose code is perfect while the project was missing a secret,
    // function or migration that code needs. A declared migration travels with
    // the question so the plan working is never mistaken for drift.
    const { root, bin, log } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        backendPlan: {
          changes: [
            { id: '20260912150000', kind: 'migration' },
            { id: 'drive-connect', kind: 'function' }
          ]
        },
        allowRemote: true
      });
      expect(await adapter.execute('preflight')).toMatchObject({ ok: true });
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('node verify-web-env.mjs');
      expect(calls).toContain('node verify-production-config.mjs --expect-pending=20260912150000');
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 60_000);

  it('leaves the live project alone when the run is not allowed remote access', async () => {
    const { root, bin, log } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      expect(await adapter.execute('preflight')).toMatchObject({ ok: true });
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('node verify-web-env.mjs');
      expect(calls).not.toContain('verify-production-config.mjs');
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 60_000);

  it('refuses to start without the frozen identity the release was accepted for', async () => {
    await expect(
      createStepAdapter({ runId: 'run', version: '', sourceSha, binding })
    ).rejects.toThrow('STEP_ADAPTER_IDENTITY_INVALID');
    await expect(
      createStepAdapter({ runId: 'run', version: '1.0.0', sourceSha: 'short', binding })
    ).rejects.toThrow('STEP_ADAPTER_IDENTITY_INVALID');
    await expect(
      createStepAdapter({
        runId: 'run',
        version: '1.0.0',
        sourceSha,
        binding: null as unknown as typeof binding
      })
    ).rejects.toThrow('STEP_ADAPTER_BINDING_MISSING');
  });

  it('reports a failed command as a blocked step rather than throwing', async () => {
    const { root, bin } = await fakeProject();
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    await chmod(join(bin, 'npm'), 0o755);
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      const result = await adapter.execute('candidate_gate');
      expect(result).toMatchObject({ ok: false, error: { code: 'GATE_FAILED' } });
      expect(result.error.subject).toContain('boom');
    } finally {
      await removeTemporaryDirectory(root);
    }
  }, 30_000);
});
