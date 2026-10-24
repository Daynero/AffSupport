import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimBetaStartup } from '../scripts/lib/beta-startup-record.mjs';
import { digestOf } from '../scripts/lib/release/adapters/beta.mjs';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
);
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'soty-beta-recovery-'));
  directories.push(dir);
  const file = path.join(dir, 'release/automation/beta-service.json');
  const initial = {
    schemaVersion: 1,
    ownerPid: 999999,
    agentPid: null,
    webPid: null,
    ports: [43140, 5175],
    stackStarted: true,
    phase: 'starting',
    writtenEnvironment: []
  };
  return { dir, file, initial };
}
it('claims a complete private journal exclusively, before any child exists', () => {
  const { file, initial } = fixture();
  const owned = claimBetaStartup(file, initial);
  const bytes = readFileSync(file, 'utf8');
  expect(JSON.parse(bytes)).toMatchObject(initial);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(() => claimBetaStartup(file, { ...initial, ownerPid: 12 })).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  owned.update({ agentPid: 44 });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ agentPid: 44, phase: 'starting' });
});
it('does not overwrite a replacement ownership record', () => {
  const { file, initial } = fixture();
  const owned = claimBetaStartup(file, initial);
  writeFileSync(file, JSON.stringify({ ownerId: 'replacement' }));
  expect(() => owned.update({ phase: 'running' })).toThrow('BETA_STARTUP_OWNERSHIP_CHANGED');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ownerId: 'replacement' });
});
it.each([false, true])(
  'actual beta:down reconciles a partial start (borrowed listener=%s)',
  borrowed => {
    const { dir, file, initial } = fixture();
    const runtimeEnv = path.join(dir, 'functions.env');
    const backup = path.join(dir, 'functions.backup');
    writeFileSync(runtimeEnv, 'owned beta fixture');
    writeFileSync(backup, 'previous fixture');
    claimBetaStartup(file, {
      ...initial,
      writtenEnvironment: [
        { file: runtimeEnv, restoreFrom: backup, digest: digestOf(readFileSync(runtimeEnv)) }
      ]
    });
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    // Run the actual stop script, but isolate OS/Docker observations in this child.
    // Neither the live beta nor any host listener is queried or signalled.
    writeFileSync(
      path.join(bin, 'lsof'),
      `#!${process.execPath}\n${borrowed ? "process.stdout.write('999998\\n');" : 'process.exitCode=1;'}`,
      { mode: 0o700 }
    );
    writeFileSync(
      path.join(bin, 'npx'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'stopped.json'))},JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o700 }
    );
    const result = spawnSync(process.execPath, [path.resolve('scripts/beta-down.mjs')], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15000
    });
    if (borrowed) {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('borrowed');
      expect(existsSync(path.join(dir, 'stopped.json'))).toBe(false);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(runtimeEnv, 'utf8')).toBe('owned beta fixture');
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, 'stopped.json'), 'utf8'))).toEqual([
        'supabase',
        'stop'
      ]);
      expect(readFileSync(runtimeEnv, 'utf8')).toBe('previous fixture');
      expect(existsSync(file)).toBe(false);
    }
  }
);
