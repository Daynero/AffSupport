import { mkdtemp, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxIntent } from './support/release-runner/fixtures';

describe('release runner CLI', () => {
  it('accepts a start durably and makes it visible to status', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'release-cli-'));
    const intentPath = path.join(directory, 'intent.json');
    await writeFile(intentPath, JSON.stringify(sandboxIntent));
    try {
      const env = { ...process.env, SOTY_RELEASE_RUNNER_DIR: directory };
      const start = spawnSync(
        process.execPath,
        ['scripts/release-runner.mjs', 'start', '--intent', intentPath],
        { cwd: process.cwd(), env, encoding: 'utf8' }
      );
      expect(JSON.parse(start.stdout)).toMatchObject({
        ok: true,
        state: 'queued',
        data: { accepted: true, worker: { pid: expect.any(Number) } }
      });
      const status = spawnSync(
        process.execPath,
        ['scripts/release-runner.mjs', 'status', sandboxIntent.runId],
        { cwd: process.cwd(), env, encoding: 'utf8' }
      );
      expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, state: 'queued' });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('separates accepted, waiting, blocked and cancelled in its exit codes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'release-cli-exit-'));
    const intentPath = path.join(directory, 'intent.json');
    await writeFile(intentPath, JSON.stringify(sandboxIntent));
    const env = { ...process.env, SOTY_RELEASE_RUNNER_DIR: directory };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/release-runner.mjs', ...args], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8'
      });
    try {
      expect(run('start', '--intent', intentPath).status).toBe(0);

      // A queued run is active, not finished and not broken.
      const report = run('report', sandboxIntent.runId, '--json');
      expect(report.status).toBe(3);
      expect(JSON.parse(report.stdout)).toMatchObject({
        ok: true,
        data: {
          phase: 'preflight',
          remainingSteps: expect.arrayContaining(['publish']),
          publicationState: 'none',
          metrics: { handoffs: 0, modelTokens: null }
        }
      });
      // status only claims the snapshot is readable.
      expect(run('status', sandboxIntent.runId).status).toBe(0);

      expect(run('cancel', sandboxIntent.runId).status).toBe(4);
      expect(run('report', sandboxIntent.runId).status).toBe(4);

      // Invalid input is a category of its own, never a blocked release.
      expect(run('start', '--intent', path.join(directory, 'absent.json')).status).toBe(2);
      expect(run('nonsense').status).toBe(2);
    } finally {
      await removeTemporaryDirectory(directory);
    }
  }, 30_000);

  it('reports installed prerequisites in preflight without doing heavy work', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'release-cli-preflight-'));
    const intentPath = path.join(directory, 'intent.json');
    const bindingsPath = path.join(directory, 'bindings.json');
    await writeFile(intentPath, JSON.stringify(sandboxIntent));
    await writeFile(
      bindingsPath,
      JSON.stringify({
        [sandboxIntent.targetId]: {
          kind: 'sandbox',
          bindingId: sandboxIntent.targetId,
          repository: 'example/sandbox',
          releaseRepository: 'example/sandbox-releases',
          siteOrigin: 'https://sandbox.example.test',
          cloudflareProject: 'sandbox-pages',
          supabaseProject: 'sandbox-db',
          signingKeyFingerprint: 'sandbox-public',
          artifactUrlBase: 'https://example.test/sandbox'
        }
      })
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/release-runner.mjs',
          'preflight',
          '--intent',
          intentPath,
          '--bindings',
          bindingsPath
        ],
        {
          cwd: process.cwd(),
          // No probe and no bridge are configured on this machine.
          env: { ...process.env, SOTY_RELEASE_RUNNER_DIR: directory },
          encoding: 'utf8'
        }
      );
      expect(result.status).toBe(2);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        state: 'blocked',
        error: { code: 'PROBE_UNAVAILABLE' }
      });
      // Heavy prerequisites are named as scheduled work, never performed here.
      expect(envelope.data.scheduledWork).toContain('macos_package');
      expect(envelope.data.scheduledWork).not.toContain('preflight');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  }, 30_000);
});
