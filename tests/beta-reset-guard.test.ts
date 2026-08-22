import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BETA_PROFILE, evaluateResetTarget } from '../packages/shared/src/environment.js';

const RESET = readFileSync('scripts/beta-reset.mjs', 'utf8');

describe('beta reset safety', () => {
  it('refuses a remote target', () => {
    const problem = evaluateResetTarget(
      'postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
    );
    expect(problem?.code).toBe('BETA_RESET_TARGET_UNSAFE');
    expect(problem?.subject).toBe('SUPABASE_DB_URL');
  });

  it('refuses a target it cannot parse rather than assuming it is local', () => {
    expect(evaluateResetTarget('postgres-host-without-scheme')?.code).toBe(
      'BETA_RESET_TARGET_UNSAFE'
    );
  });

  it('allows the local stack and an unset target', () => {
    expect(evaluateResetTarget('postgresql://postgres@127.0.0.1:54322/postgres')).toBeNull();
    expect(evaluateResetTarget(undefined)).toBeNull();
  });

  it('checks the target before the first destructive operation', () => {
    // A misconfigured profile must cost nothing, not cause partial damage.
    const guardIndex = RESET.indexOf('evaluateResetTarget');
    const resetIndex = RESET.indexOf("'db', 'reset'");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(guardIndex);
  });

  it('clears resettable state only inside beta application support', () => {
    expect(RESET).toContain('BETA_PROFILE.supportDirectoryName');
    expect(BETA_PROFILE.supportDirectoryName).toBe('Soty Beta');
    // A hardcoded directory name here is one typo away from wiping production
    // or dev state.
    expect(RESET).not.toContain("'Soty'");
    expect(RESET).not.toContain("'Soty Dev'");
  });

  it('preserves downloaded models, runtimes and resumable partial downloads', () => {
    expect(RESET).toContain("new Set(['models', 'runtime'])");
    expect(RESET).toContain('including resumable .part downloads');
    expect(RESET).not.toContain('rmSync(supportDirectory');
  });

  it('applies the fixtures explicitly rather than as a shared seed', () => {
    // config.toml's seed would change behaviour for anyone running the local
    // stack for other reasons.
    expect(RESET).toContain('supabase/fixtures/beta-seed.sql');
    expect(readFileSync('supabase/config.toml', 'utf8')).not.toContain('beta-seed.sql');
  });

  it('fails loudly when the fixtures cannot be applied', () => {
    expect(RESET).toContain('migrated but not seeded');
  });
});
