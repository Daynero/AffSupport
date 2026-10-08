import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createControllerRunner } from '../scripts/lib/release/controller-runner.mjs';
import { productionBinding } from '../scripts/lib/release/bindings.mjs';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'controller-binding-'));
  await mkdir(path.join(root, 'scripts'));
  await copyFile(
    path.resolve('tests/fixtures/release-controller-runner.mjs'),
    path.join(root, 'scripts/release-runner.mjs')
  );
  const binding = {
    kind: 'sandbox',
    bindingId: 'test-sandbox',
    repository: 'test/sandbox',
    releaseRepository: 'test/sandbox-release',
    siteOrigin: 'https://sandbox.example',
    cloudflareProject: 'test-sandbox',
    supabaseProject: 'test-sandbox-db',
    signingKeyFingerprint: 'b'.repeat(64),
    artifactUrlBase: 'https://sandbox.example/assets'
  };
  const bindingsPath = path.join(root, 'bindings.json');
  const bindings = { production: productionBinding(), 'test-sandbox': binding };
  await writeFile(bindingsPath, JSON.stringify(bindings));
  const capture = path.join(root, 'capture.json');
  const runner = createControllerRunner({
    root,
    repositoryRoot: root,
    bindingsPath,
    env: {
      ...process.env,
      CONTROLLER_TEST_CAPTURE: capture,
      SOTY_RELEASE_BINDING: '/must-not-inherit'
    }
  });
  const intent = {
    schemaVersion: 1,
    runId: randomUUID(),
    repository: binding.repository,
    version: '1.2.5',
    sourceSha: 'a'.repeat(40),
    targetId: binding.bindingId,
    targetKind: 'sandbox',
    notes: { digest: 'c'.repeat(64) }
  };
  return { runner, bindings, bindingsPath, intent, capture };
}
describe('canonical runner binding boundary', () => {
  it('pins sandbox destinations and controller-only handoff ownership in worker environment', async () => {
    const f = await fixture();
    await f.runner.validate(f.intent);
    await f.runner.start(f.intent);
    const captured = JSON.parse(await readFile(f.capture, 'utf8'));
    expect(captured.binding.kind).toBe('sandbox');
    expect(captured.binding.repository).toBe('test/sandbox');
    expect(captured.owner).toBe('controller');
    expect(captured.intent.runId).toBe(f.intent.runId);
    f.bindings['test-sandbox'].cloudflareProject = 'changed';
    await writeFile(f.bindingsPath, JSON.stringify(f.bindings));
    await expect(f.runner.start(f.intent)).rejects.toThrow('TARGET_BINDING_CHANGED');
  });
  it('refuses reused run identity, foreign repository and missing production acceptance', async () => {
    const f = await fixture();
    await f.runner.validate(f.intent);
    await expect(
      f.runner.validate({ ...f.intent, notes: { digest: 'd'.repeat(64) } })
    ).rejects.toThrow('RUN_IDENTITY_CONFLICT');
    await expect(
      f.runner.validate({ ...f.intent, repository: 'foreign/repository' })
    ).rejects.toThrow('RELEASE_REPOSITORY_SCOPE_MISMATCH');
    const production = {
      ...f.intent,
      runId: randomUUID(),
      repository: f.bindings.production.repository,
      targetId: 'production',
      targetKind: 'production'
    };
    await expect(f.runner.start(production)).rejects.toThrow('PRODUCTION_ACTIVATION_NOT_PROVEN');
  });
});
