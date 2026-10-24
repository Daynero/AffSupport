import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scanAcceptanceIsolation } from '../scripts/lib/acceptance-isolation.mjs';
import { FAULT_MARKER } from '../scripts/acceptance/fault-model.mjs';

const roots: string[] = [];
const runner = path.resolve('scripts/verify-acceptance-isolation.mjs');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'soty-release-isolation-'));
  roots.push(root);
  for (const name of [
    'supabase/migrations',
    'supabase/functions',
    'supabase/fixtures',
    'apps/web/dist'
  ])
    mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(
    path.join(root, 'supabase/migrations/real.sql'),
    'create function private.tariff_now() returns timestamptz language sql as $$ select pg_catalog.now() $$;'
  );
  writeFileSync(
    path.join(root, 'supabase/fixtures/acceptance-clock.sql'),
    readFileSync('supabase/fixtures/acceptance-clock.sql')
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  'supabase/migrations/fault.sql',
  'supabase/functions/fault.ts',
  'apps/web/dist/fault.js',
  '.env.production.local'
])('rejects the actual scoped fault marker in release input %s', file => {
  const root = fixture();
  writeFileSync(path.join(root, file), `PRIVATE_VALUE=do-not-report\n${FAULT_MARKER}`);
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).problems).toContainEqual({
    code: 'ACCEPTANCE_FIXTURE_IN_RELEASE',
    file,
    marker: 'scoped-faults'
  });
  expect(result.stdout).not.toContain('do-not-report');
});

it('allows the production-real seam and excludes the legitimate local fixture directory', () => {
  const result = JSON.parse(
    execFileSync(process.execPath, [runner], { cwd: fixture(), encoding: 'utf8' })
  );
  expect(result).toMatchObject({ ok: true, builtWebPresent: true, scannedFiles: 1, problems: [] });
});

it('fails the actual command when the local clock fixture is copied into the migration chain', () => {
  const root = fixture();
  writeFileSync(
    path.join(root, 'supabase/migrations/copied.sql'),
    readFileSync('supabase/fixtures/acceptance-clock.sql')
  );
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).problems).toContainEqual({
    code: 'ACCEPTANCE_FIXTURE_IN_RELEASE',
    file: 'supabase/migrations/copied.sql',
    marker: 'tariff-clock-overlay'
  });
});

it.each(['supabase/functions/capture.ts', 'apps/web/dist/capture.js', '.env.production.local'])(
  'rejects capture activation in %s without exposing contents',
  file => {
    const root = fixture();
    writeFileSync(
      path.join(root, file),
      'SECRET_DO_NOT_REPORT=sensitive\nsoty.acceptance.capture.v1'
    );
    const result = scanAcceptanceIsolation({ root });
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      code: 'ACCEPTANCE_FIXTURE_IN_RELEASE',
      file,
      marker: 'diagnostic-capture'
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  }
);

it('reports an absent build separately and fails missing migration evidence', () => {
  const root = fixture();
  rmSync(path.join(root, 'apps/web/dist'), { recursive: true });
  expect(scanAcceptanceIsolation({ root })).toMatchObject({ ok: true, builtWebPresent: false });
  rmSync(path.join(root, 'supabase/migrations'), { recursive: true });
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual({
    code: 'ACCEPTANCE_ISOLATION_UNREADABLE',
    file: 'supabase/migrations'
  });
});

it('refuses linked migration input instead of silently skipping it', () => {
  const root = fixture();
  symlinkSync(
    path.join(root, 'supabase/fixtures'),
    path.join(root, 'supabase/migrations/linked'),
    'junction'
  );
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual({
    code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH',
    file: 'supabase/migrations/linked'
  });
});

it('checks deployable SQL/functions for beta without treating its development web bundle as production', () => {
  const root = fixture();
  writeFileSync(path.join(root, 'apps/web/dist/beta.js'), 'soty.acceptance.capture.v1');
  expect(scanAcceptanceIsolation({ root, productionArtifacts: false }).ok).toBe(true);
  writeFileSync(
    path.join(root, 'supabase/functions/leaked.sql'),
    'select * from private."ACCEPTANCE_TARIFF_CLOCK";'
  );
  expect(scanAcceptanceIsolation({ root, productionArtifacts: false }).ok).toBe(false);
});

it.each(['contract', 'candidate', 'final'])(
  'the actual %s release verifier rejects an overlay before reading any target binding',
  mode => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'supabase/migrations/copied.sql'),
      readFileSync('supabase/fixtures/acceptance-clock.sql')
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts/verify-release.mjs'), `--mode=${mode}`],
      {
        cwd: root,
        env: { ...process.env, SOTY_RELEASE_BINDING: path.join(root, 'must-not-read.json') },
        encoding: 'utf8',
        timeout: 10000
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ACCEPTANCE_ISOLATION');
    expect(result.stderr).toContain('tariff-clock-overlay');
    expect(result.stderr).not.toContain('must-not-read');
    expect(result.stdout).toBe('');
  }
);

it('the actual beta doctor refuses an overlay before checking profiles or probing services', () => {
  const root = fixture();
  writeFileSync(path.join(root, 'supabase/functions/leak.ts'), 'soty.acceptance.capture.v1');
  const result = spawnSync(process.execPath, [path.resolve('scripts/verify-beta-env.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ACCEPTANCE_ISOLATION');
  expect(result.stderr).not.toContain('BETA_ENV_MISSING');
  expect(result.stdout).toBe('');
});

it.each(['supabase', 'apps'])('refuses a linked %s ancestor of a scanned input', directory => {
  const root = fixture();
  const original = path.join(root, directory);
  const target = path.join(root, `${directory}-outside-input`);
  renameSync(original, target);
  symlinkSync(target, original, 'junction');
  const result = scanAcceptanceIsolation({ root });
  expect(result.ok).toBe(false);
  expect(
    result.problems.some(
      problem =>
        problem.code === 'ACCEPTANCE_ISOLATION_UNSAFE_PATH' &&
        problem.file.startsWith(`${directory}/`)
    )
  ).toBe(true);
});

it('accepts the exact local edge env alias while still inspecting its real file and refusing redirected aliases', () => {
  const root = fixture();
  const directory = path.join(root, 'supabase/functions');
  writeFileSync(path.join(directory, '.env.local'), 'LOCAL_ONLY=true\n');
  symlinkSync('.env.local', path.join(directory, '.env'));
  expect(scanAcceptanceIsolation({ root }).ok).toBe(true);
  writeFileSync(path.join(directory, '.env.local'), 'CAPTURE=soty.acceptance.mail-capture.v1\n');
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual(
    expect.objectContaining({
      code: 'ACCEPTANCE_FIXTURE_IN_RELEASE',
      file: 'supabase/functions/.env',
      marker: 'mail-capture'
    })
  );
  rmSync(path.join(directory, '.env.local'));
  symlinkSync('../../outside.env', path.join(directory, '.env.local'));
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual(
    expect.objectContaining({
      code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH',
      file: 'supabase/functions/.env'
    })
  );
  rmSync(path.join(directory, '.env'));
  symlinkSync('../../outside.env', path.join(directory, '.env'));
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual(
    expect.objectContaining({
      code: 'ACCEPTANCE_ISOLATION_UNSAFE_PATH',
      file: 'supabase/functions/.env'
    })
  );
});

it.each([
  'supabase/functions/copied.mjs',
  'apps/agent/src/copied.mjs',
  'apps/agent/dist/copied.js',
  'apps/web/dist/copied.js'
])('rejects the actual fault adapter copied into %s even without the SQL marker', file => {
  const root = fixture();
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  const source = readFileSync('scripts/acceptance/fault-effects.mjs', 'utf8');
  expect(source).not.toContain(FAULT_MARKER);
  writeFileSync(path.join(root, file), source);
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual(
    expect.objectContaining({ file, marker: 'scoped-faults' })
  );
});

it.each(['scripts/acceptance/fault-worker.mjs', 'scripts/acceptance/fault-worker-fixture.mjs'])(
  'rejects a copied native checkpoint helper %s in deployable Functions',
  source => {
    const root = fixture(),
      file = 'supabase/functions/copied-worker.mjs';
    writeFileSync(path.join(root, file), readFileSync(source));
    expect(scanAcceptanceIsolation({ root }).problems).toContainEqual(
      expect.objectContaining({ file, marker: 'scoped-faults' })
    );
  }
);
