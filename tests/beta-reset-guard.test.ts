import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BETA_PROFILE, evaluateResetTarget } from '../packages/shared/src/environment.js';
import { betaResetStackTarget, resetOwnedBetaStack } from '../scripts/lib/beta-reset-stack.mjs';

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
    const resetIndex = RESET.indexOf('  resetOwnedBetaStack({');
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

const resetProject = 'r2beta045';
const resetNetwork = `soty-beta-${resetProject}-loopback`;
const resetConfig = `project_id = "${resetProject}"\n[db]\nport = 54322\n[auth]\n`;
const resetTarget = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const resetOwnership = {
  schemaVersion: 1,
  stackStarted: true,
  phase: 'running',
  ownerId: '11111111-1111-4111-8111-111111111111',
  stackNetwork: { name: resetNetwork }
};

function resetFixture(
  fault?:
    | 'remote'
    | 'foreign-owner'
    | 'foreign-member'
    | 'wrong-db-port'
    | 'ipv6-only'
    | 'unsafe-before'
    | 'unsafe-after'
    | 'reset-error'
    | 'context-switch'
    | 'config-before'
    | 'config-after'
) {
  let resetCalled = false;
  let currentConfig = resetConfig;
  let currentContext = 'colima';
  const env: NodeJS.ProcessEnv = { DOCKER_CONTEXT: 'colima' };
  const run = vi.fn((args: string[], _options?: { env: NodeJS.ProcessEnv }) => {
    if (args.includes('reset')) {
      resetCalled = true;
      if (fault === 'config-after') currentConfig = resetConfig.replace(resetProject, 'wishly');
      if (fault === 'context-switch') {
        currentContext = 'foreign';
        env.DOCKER_CONTEXT = 'foreign';
        env.DOCKER_HOST = 'ssh://foreign';
      }
    }
    return { status: fault === 'reset-error' && args.includes('reset') ? 1 : 0 };
  });
  const docker = vi.fn((args: string[], _options?: { env: NodeJS.ProcessEnv }) => {
    const id = 'a'.repeat(12);
    let stdout: string;
    if (args[0] === 'context' && args[1] === 'show') stdout = currentContext;
    else if (args[0] === 'context')
      stdout = JSON.stringify(
        fault === 'remote' || currentContext === 'foreign'
          ? 'ssh://foreign'
          : 'unix:///tmp/docker.sock'
      );
    else if (args[0] === 'ps') stdout = id;
    else if (args[0] === 'network')
      stdout = JSON.stringify([
        {
          Name: resetNetwork,
          Driver: 'bridge',
          Scope: 'local',
          Internal: false,
          EnableIPv6: false,
          Options: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' },
          Labels: {
            'com.soty.beta.loopback': 'v1',
            'com.soty.beta.project': fault === 'foreign-owner' ? 'wishly' : resetProject
          },
          Containers: { [fault === 'foreign-member' ? 'b'.repeat(64) : 'a'.repeat(64)]: {} }
        }
      ]);
    else if (args[0] === 'inspect')
      stdout = JSON.stringify({
        Networks: { [resetNetwork]: {} },
        Ports: {
          '5432/tcp': [
            {
              HostIp:
                fault === 'unsafe-before' || (fault === 'unsafe-after' && resetCalled)
                  ? '0.0.0.0'
                  : fault === 'ipv6-only'
                    ? '::1'
                    : '127.0.0.1',
              HostPort: fault === 'wrong-db-port' ? '54399' : '54322'
            }
          ]
        }
      });
    else throw new Error(`Unexpected Docker call: ${args[0]}`);
    if (fault === 'config-before' && args[0] === 'network')
      currentConfig = resetConfig.replace(resetProject, 'wishly');
    return { status: 0, stdout };
  });
  const execute = () =>
    resetOwnedBetaStack({
      config: resetConfig,
      ownership: resetOwnership,
      target: resetTarget,
      run,
      docker,
      env,
      readConfig: () => currentConfig
    });
  return { run, docker, execute };
}

describe('owned beta reset orchestration', () => {
  it('pins local reset to the journaled project bridge and checks again before fixture access', () => {
    const f = resetFixture();
    const seed = vi.fn();
    f.execute();
    seed();
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      ['supabase', 'db', 'reset', '--local', '--network-id', resetNetwork],
      { env: expect.objectContaining({ DOCKER_HOST: 'unix:///tmp/docker.sock' }) }
    );
    expect(
      f.docker.mock.calls.filter(([args]) => args[0] === 'network' && args[1] === 'inspect')
    ).toHaveLength(2);
    expect(seed).toHaveBeenCalledOnce();
    expect(RESET.indexOf('  resetOwnedBetaStack({')).toBeLessThan(
      RESET.indexOf('const client = new pg.Client')
    );
  });

  it.each([
    'remote',
    'foreign-owner',
    'foreign-member',
    'wrong-db-port',
    'ipv6-only',
    'unsafe-before'
  ] as const)('refuses %s without any reset or stop', fault => {
    const f = resetFixture(fault);
    expect(f.execute).toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('stops only the proven-owned project and blocks seeding if reset exposes a wildcard binding', () => {
    const f = resetFixture('unsafe-after');
    const seed = vi.fn();
    expect(() => {
      f.execute();
      seed();
    }).toThrow('BETA_LOOPBACK_BINDING_INVALID');
    expect(f.run.mock.calls.map(([args]) => args)).toEqual([
      ['supabase', 'db', 'reset', '--local', '--network-id', resetNetwork],
      ['supabase', 'stop', '--project-id', resetProject]
    ]);
    expect(seed).not.toHaveBeenCalled();
  });

  it('does not seed after CLI failure even when post-reset ports remain safe', () => {
    const f = resetFixture('reset-error');
    expect(f.execute).toThrow('did not complete');
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.docker.mock.calls.filter(([args]) => args[0] === 'network')).toHaveLength(2);
  });

  it.each([
    ['missing ownership', null, resetTarget],
    [
      'different project journal',
      { ...resetOwnership, stackNetwork: { name: 'soty-beta-wishly-loopback' } },
      resetTarget
    ],
    ['unreconciled startup', { ...resetOwnership, phase: 'starting' }, resetTarget],
    ['different local database', resetOwnership, 'postgresql://postgres@127.0.0.1:54399/postgres'],
    ['connection option redirect', resetOwnership, `${resetTarget}?host=remote.example`]
  ])('rejects %s before Docker or reset', (_label, ownership, target) => {
    expect(() => betaResetStackTarget(resetConfig, ownership, target)).toThrow(
      'BETA_RESET_STACK_UNSAFE'
    );
  });

  it('uses the CLI default database port when config omits it', () => {
    expect(
      betaResetStackTarget(
        `project_id = "${resetProject}"\n[db]\n[auth]\n`,
        resetOwnership,
        resetTarget
      ).databasePort
    ).toBe(54322);
  });

  it.each(['[::1]', 'localhost'])(
    'rejects seed host %s because the owned database is proven on canonical IPv4 loopback',
    host => {
      const f = resetFixture();
      expect(() =>
        resetOwnedBetaStack({
          config: resetConfig,
          ownership: resetOwnership,
          target: `postgresql://postgres:postgres@${host}:54322/postgres`,
          run: f.run,
          docker: f.docker,
          env: {},
          readConfig: () => resetConfig
        })
      ).toThrow('BETA_RESET_STACK_UNSAFE');
      expect(f.docker).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it('pins every verification and CLI child to the captured endpoint when Docker context changes', () => {
    const f = resetFixture('context-switch');
    f.execute();
    const allCalls = [...f.docker.mock.calls, ...f.run.mock.calls];
    for (const [args, options] of allCalls) {
      if (args[0] === 'context') continue;
      expect(options?.env.DOCKER_HOST).toBe('unix:///tmp/docker.sock');
      expect(options?.env.DOCKER_CONTEXT).toBeUndefined();
      expect(Object.isFrozen(options?.env)).toBe(true);
    }
    expect(f.docker.mock.calls.filter(([args]) => args[0] === 'context')).toHaveLength(1);
  });

  it('refuses config changes at the destructive boundary without invoking reset or stop', () => {
    const f = resetFixture('config-before');
    expect(f.execute).toThrow('BETA_RESET_STACK_UNSAFE');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('never follows a changed project config for emergency stop or fixture seeding', () => {
    const f = resetFixture('config-after');
    const seed = vi.fn();
    expect(() => {
      f.execute();
      seed();
    }).toThrow('BETA_LOOPBACK_BINDING_INVALID');
    expect(f.run.mock.calls[1]).toEqual([
      ['supabase', 'stop', '--project-id', resetProject],
      { env: expect.objectContaining({ DOCKER_HOST: 'unix:///tmp/docker.sock' }) }
    ]);
    expect(f.run.mock.calls[1][1]?.env.DOCKER_CONTEXT).toBeUndefined();
    expect(seed).not.toHaveBeenCalled();
  });
});
