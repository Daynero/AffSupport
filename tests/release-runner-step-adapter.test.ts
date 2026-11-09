import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStepAdapter } from '../scripts/lib/release/step-adapter.mjs';
import { releaseArtifactName } from '../packages/shared/src/release';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';
import { itRequiring, requirePlatform } from './support/requires.js';

/**
 * These cases drive the release runner against a real filesystem: POSIX file
 * modes, unix socket paths, `#!/bin/sh` stand-ins on PATH and the executable
 * bit. On Windows they fail on the platform rather than on the behaviour — and
 * they would never run there anyway, because a release is cut on the owner's
 * Mac and Windows artifacts come back from CI.
 */
const posixReleaseHost = requirePlatform('darwin', 'linux');

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
  for (const name of ['npm', 'gh', 'zsh']) {
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
    'verify-live-smoke.mjs',
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
        expect(
          `${stepId}:${result.ok || ['ACCESS_UNAVAILABLE', 'GATE_FAILED'].includes(result.error.code)}`
        ).toBe(`${stepId}:true`);
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

  itRequiring(
    posixReleaseHost,
    'runs the commands the production runbook names, in its order',
    async () => {
      const { root, bin, log } = await fakeProject();
      try {
        const adapter = await createStepAdapter({
          runId: 'run',
          version: '9.9.9',
          sourceSha,
          cwd: root,
          // A release without a certificate says so; the default policy would stop
          // macos_package at the 048 trust preflight (tested below).
          env: { PATH: `${bin}:${process.env.PATH}`, SOTY_MACOS_TRUST_POLICY: 'adhoc-pre-048' },
          binding,
          allowRemote: false
        });
        for (const stepId of ['candidate_gate', 'beta_package', 'macos_package']) {
          expect(await adapter.execute(stepId)).toMatchObject({ ok: true });
        }
        // Shell stand-ins cannot produce physical, sealed ARM/Intel evidence.
        expect(await adapter.execute('beta_verify')).toMatchObject({
          ok: false,
          error: { code: 'GATE_FAILED' }
        });
        const calls = await readFile(log, 'utf8');
        expect(calls).toContain('npm run release:check');
        expect(calls).toContain('npm run beta:package');
        expect(calls).toContain(`zsh ${process.cwd()}/scripts/verify-beta-package.sh`);
        // Intel static qualification is re-run at the current HEAD by the runner
        // itself, not left to a hand-run record from an earlier commit.
        expect(calls).toContain(`zsh ${process.cwd()}/scripts/verify-beta-package.sh --arch=x64`);
        expect(calls).toContain('npm run package:mac');
        expect(calls).toContain('npm run package:dmg');
      } finally {
        await removeTemporaryDirectory(root);
      }
    },
    60_000
  );

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

  it('finishes only after asking the live site whether the deployment works', async () => {
    // The release used to end at "the artifacts are downloadable", which is true
    // of a release whose site serves the previous bundle to every user.
    const { root, bin, log } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: true
      });
      expect(await adapter.execute('live_verify')).toMatchObject({ ok: true });
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('node verify-published-release.mjs');
      expect(calls).toContain('node verify-live-smoke.mjs');
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

itRequiring(
  posixReleaseHost,
  'reconciles partial Mac publication only after exact tag and immutable asset readback',
  async () => {
    const version = '9.9.9';
    const armName = releaseArtifactName('macos-arm64', version);
    const intelName = releaseArtifactName('macos-x64', version);
    for (const scenario of ['matching', 'changed-bytes', 'wrong-tag']) {
      const { root, bin, log } = await fakeProject();
      const previousPath = process.env.PATH;
      try {
        await mkdir(join(root, 'release/x64'), { recursive: true });
        await writeFile(join(root, 'release', armName), 'arm fixture');
        await writeFile(join(root, 'release/x64', intelName), 'intel fixture');
        // Trust is a separate gate; this fixture exercises publication adoption,
        // and records where the gate would mount the DMG.
        await writeFile(
          join(root, 'scripts/verify-macos-release-trust.mjs'),
          `import { appendFileSync } from 'node:fs';\n` +
            `appendFileSync(${JSON.stringify(log)}, 'trust TMPDIR=' + process.env.TMPDIR + '\\n');\n` +
            // The gate's record is what publish journals (048 T013); the pre-048 policy
            // claims no Apple trust.
            `const arch = process.argv.includes('--arch=x64') ? 'x64' : 'arm64';\n` +
            `process.stdout.write(JSON.stringify({ target: 'macos-' + arch, trustPolicy: 'adhoc-pre-048', appleTrust: 'unverified', developerId: false, notarized: false, stapled: false }) + '\\n');\n`
        );
        await writeFile(
          join(bin, 'git'),
          `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},'git '+a.join(' ')+'\\n');if(a[0]==='rev-parse')process.stdout.write(${JSON.stringify(scenario === 'wrong-tag' ? 'b'.repeat(40) : sourceSha)}+'\\n');
`
        );
        await chmod(join(bin, 'git'), 0o755);
        await writeFile(
          join(bin, 'gh'),
          `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},'gh '+a.join(' ')+'\\n');if(a[0]==='release'&&a[1]==='view')process.stdout.write(JSON.stringify({assets:[{name:${JSON.stringify(armName)}}]}));else if(a[0]==='release'&&a[1]==='download'){const dir=a[a.indexOf('--dir')+1];fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,${JSON.stringify(armName)}),${JSON.stringify(scenario === 'changed-bytes' ? 'changed fixture' : 'arm fixture')});}else if(a[0]==='run')process.stdout.write('not-json');else if(a[0]==='workflow')process.exit(1);
`
        );
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        const adapter = await createStepAdapter({
          runId: 'run',
          version,
          sourceSha,
          cwd: root,
          env: { PATH: process.env.PATH, SOTY_MACOS_TRUST_POLICY: 'adhoc-pre-048' },
          binding,
          allowRemote: true
        });
        const result = await adapter.execute('publish');
        expect(result.ok).toBe(false); // Hosted Windows evidence is deliberately absent.
        const calls = await readFile(log, 'utf8');
        // macOS refuses a mountpoint on the external release volume; 1.4.0 stopped on it.
        expect(calls).toContain('trust TMPDIR=/tmp\n');
        expect(calls).not.toContain('--clobber');
        expect(calls).not.toContain('release create');
        if (scenario === 'matching') {
          expect(calls).toContain(`release download v${version} --pattern ${armName}`);
          expect(calls).toContain(`release upload v${version} release/x64/${intelName}`);
          expect(calls).not.toContain(`release upload v${version} release/${armName}`);
        } else {
          expect(result).toMatchObject({ error: { code: 'EFFECT_AMBIGUOUS' } });
          expect(calls).not.toContain('release upload');
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await removeTemporaryDirectory(root);
      }
    }
  },
  30000
);

itRequiring(
  posixReleaseHost,
  'never dispatches a Windows workflow when the existing runs cannot be listed',
  async () => {
    const { root, bin, log } = await fakeProject();
    // The run listing resolves `gh` from the process PATH, like the publication test above.
    const previousPath = process.env.PATH;
    try {
      // `gh run list` fails (an unanswered lookup); every other gh call is recorded.
      await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh\necho "gh $*" >> ${log}\nif [ "$1" = run ] && [ "$2" = list ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi\nexit 0\n`
      );
      await chmod(join(bin, 'gh'), 0o755);
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: true
      });
      const result = await adapter.execute('windows_smoke');
      expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_UNAVAILABLE' } });
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('gh run list');
      // A lookup that went unanswered is not "no run exists": dispatching on it
      // is how 1.4.0 queued a duplicate build behind the one already running.
      expect(calls).not.toContain('gh workflow run');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await removeTemporaryDirectory(root);
    }
  },
  30_000
);

itRequiring(
  posixReleaseHost,
  'refuses to package a developer-id release until its trust inputs exist (048 T019)',
  async () => {
    const { root, bin, log } = await fakeProject();
    try {
      const adapter = await createStepAdapter({
        runId: 'run',
        version: '9.9.9',
        sourceSha,
        cwd: root,
        // The default policy is developer-id, and nothing here names an identity.
        env: { PATH: `${bin}:${process.env.PATH}` },
        binding,
        allowRemote: false
      });
      const result = await adapter.execute('macos_package');
      expect(result).toMatchObject({ ok: false, error: { code: 'GATE_FAILED' } });
      expect(result.error.subject).toContain('MACOS_TRUST_INPUTS_MISSING');
      // Nothing was built on the way to that refusal.
      expect(await readFile(log, 'utf8').catch(() => '')).not.toContain('npm run package:mac');
    } finally {
      await removeTemporaryDirectory(root);
    }
  },
  30_000
);

itRequiring(
  posixReleaseHost,
  'refuses to publish a developer-id release whose package carries no chain summary (048 T013)',
  async () => {
    const version = '9.9.9';
    const armName = releaseArtifactName('macos-arm64', version);
    const intelName = releaseArtifactName('macos-x64', version);
    const { root, log } = await fakeProject();
    try {
      await mkdir(join(root, 'release/x64'), { recursive: true });
      await writeFile(join(root, 'release', armName), 'arm fixture');
      await writeFile(join(root, 'release/x64', intelName), 'intel fixture');
      // The gate is satisfied; the summary beside the image is what is missing.
      await writeFile(
        join(root, 'scripts/verify-macos-release-trust.mjs'),
        `import { appendFileSync } from 'node:fs';\n` +
          `appendFileSync(${JSON.stringify(log)}, 'trust ' + process.argv.slice(2).join(' ') + '\\n');\n` +
          `const arch = process.argv.includes('--arch=x64') ? 'x64' : 'arm64';\n` +
          `process.stdout.write(JSON.stringify({ target: 'macos-' + arch, trustPolicy: 'developer-id', appleTrust: 'verified', developerId: true, hardenedMachO: 11, notarized: true, stapled: true }) + '\\n');\n`
      );
      const adapter = await createStepAdapter({
        runId: 'run',
        version,
        sourceSha,
        cwd: root,
        env: { PATH: process.env.PATH, MACOS_EXPECTED_TEAM_ID: 'ABCDEFGHIJ' },
        binding,
        allowRemote: true
      });
      const result = await adapter.execute('publish');
      expect(result).toMatchObject({ ok: false, error: { code: 'GATE_FAILED' } });
      expect(result.error.subject).toContain('MACOS_SIGNING_SUMMARY_REQUIRED');
      const calls = await readFile(log, 'utf8');
      expect(calls).toContain('trust ');
      expect(calls).not.toContain('release view');
    } finally {
      await removeTemporaryDirectory(root);
    }
  },
  30_000
);
