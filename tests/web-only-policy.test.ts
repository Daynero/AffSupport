import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assessWebOnlyChanges,
  comparePackagedAgentInputs,
  inspectWebOnlySource
} from '../scripts/lib/web-only-policy.mjs';

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
);

function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'soty-web-policy-'));
  temporary.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  const write = (name: string, value: string | object) => {
    const file = path.join(cwd, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const commit = () => {
    git('add', '--all');
    git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Policy test');
  git('config', 'user.email', 'policy-test@example.invalid');
  const metadata = {
    name: 'policy-fixture',
    private: true,
    version: '8.6.4',
    workspaces: ['apps/*', 'packages/*'],
    scripts: { build: 'node build.mjs' },
    dependencies: { pg: '8.0.0' }
  };
  write('package.json', metadata);
  write('apps/agent/src/index.ts', 'export const agent = 1;');
  write('packages/shared/src/release.ts', 'export const version = "8.6.4";');
  write('apps/web/package.json', { name: 'web', version: '8.6.4' });
  write('apps/web/vite.config.ts', 'export default {};');
  write(
    'scripts/package-beta-mac.sh',
    '#!/bin/zsh\nswiftc launcher.swift -o app\nafter_state=$(protected_state)\nafter_tags=$(git tag --list)\n'
  );
  write('apps/web/src/App.tsx', 'export const App = "old";');
  write('apps/web/public/.well-known/wishly/stable.json', '{"signed":"tag-placeholder"}');
  const agentSha = commit();
  git('tag', 'v8.6.4');
  return { cwd, git, write, commit, metadata, agentSha };
}

describe('web-only path fence', () => {
  it('allows only the explicitly planned new SQL while retaining native and function fences', async () => {
    const fixture = repository();
    const migration = 'supabase/migrations/20261025120000_optional_note.sql';
    fixture.write(migration, 'ALTER TABLE public.widgets ADD COLUMN note text;');
    fixture.commit();
    expect((await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' })).ok).toBe(false);
    expect(
      (
        await inspectWebOnlySource({
          cwd: fixture.cwd,
          agentRef: 'v8.6.4',
          backendPaths: [migration]
        })
      ).ok
    ).toBe(true);
    expect(
      assessWebOnlyChanges(
        [migration, 'apps/agent/src/index.ts', 'supabase/functions/f/index.ts'],
        { backendPaths: [migration] }
      ).blockers
    ).toHaveLength(2);
  });
  it('cannot exempt a migration already present in the signed agent baseline', async () => {
    const fixture = repository();
    const migration = 'supabase/migrations/20261025120000_optional_note.sql';
    fixture.write(migration, 'SELECT 1;');
    fixture.commit();
    fixture.git('tag', '-f', 'v8.6.4');
    fixture.write(migration, 'ALTER TABLE public.widgets ADD COLUMN note text;');
    const packageSha = fixture.commit();
    expect(
      (
        await comparePackagedAgentInputs({
          cwd: fixture.cwd,
          agentRef: 'v8.6.4',
          packageSha,
          backendPaths: [migration]
        })
      ).blockers
    ).toContainEqual({ path: migration, code: 'DB_EXISTING_MIGRATION_CHANGED' });
  });
  it('allows application/static content and explicitly reviewed supporting files', () => {
    expect(
      assessWebOnlyChanges([
        'apps/web/src/team/Feature.tsx',
        'apps/web/public/logo.svg',
        'apps/web/public/.well-known/wishly/stable.json',
        'docs/PRODUCTION.md',
        'tests/web-only-policy.test.ts',
        'specs/043-mini-release/spec.md',
        'scripts/lib/web-only-policy.mjs',
        'scripts/lib/release/execute.mjs',
        'scripts/release-web-only.mjs'
      ])
    ).toEqual({ ok: true, blockers: [] });
  });

  it('allows only the reviewed beta payload enrollment infrastructure, not arbitrary package scripts', () => {
    expect(
      assessWebOnlyChanges([
        'scripts/package-beta-mac.sh',
        'scripts/beta-package-provenance.mjs',
        'scripts/verify-beta-package.sh'
      ])
    ).toEqual({ ok: true, blockers: [] });
    for (const name of [
      'scripts/package-mac.sh',
      'scripts/package-dev-mac.sh',
      'scripts/package-beta-windows.ps1',
      'scripts/stage-agent-runtime.mjs'
    ]) {
      expect(assessWebOnlyChanges([name])).toEqual({
        ok: false,
        blockers: [{ path: name, code: 'WEB_ONLY_AGENT_INPUT_CHANGED' }]
      });
    }
  });

  it.each([
    'apps/agent/src/index.ts',
    'packages/shared/src/types.ts',
    'packaging/Launcher.swift',
    'config/production.env',
    'supabase/functions/example/index.ts',
    'supabase/migrations/20261025000000_example.sql',
    'package-lock.json',
    'pnpm-lock.yaml',
    'apps/web/package.json',
    'apps/web/vite.config.ts',
    'apps/web/tsconfig.app.json',
    'scripts/stage-agent-runtime.mjs',
    'scripts/package-mac.sh',
    'scripts/lib/release/adapters/package.mjs',
    '.github/workflows/release.yml',
    'unknown-file.mjs',
    '../apps/web/src/escape.ts',
    'apps/web/src/../package.json',
    'apps\\web\\src\\escape.ts',
    '/apps/web/src/absolute.ts'
  ])('rejects protected or unknown input %s', name => {
    const result = assessWebOnlyChanges(['apps/web/src/safe.ts', name]);
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(1);
  });

  it.each([
    'apps/web/public/_worker.js',
    'apps/web/public/_worker.js/index.js',
    'apps/web/public/_routes.json',
    'apps/web/public/_redirects',
    'apps/web/public/_headers',
    'apps/web/public/nested/_worker.js',
    'apps/web/public/nested/_routes.json',
    'apps/web/public/nested/_redirects',
    'apps/web/public/nested/_headers',
    'apps/web/public/_WORKER.JS/index.js'
  ])('rejects public hosting/backend behavior disguised as static content: %s', name => {
    expect(assessWebOnlyChanges([name])).toEqual({
      ok: false,
      blockers: [{ path: name, code: 'WEB_ONLY_HOSTING_INPUT_CHANGED' }]
    });
  });
});

describe('complete historical packaged-agent input comparison', () => {
  const packager =
    '#!/bin/zsh\nswiftc launcher.swift -o app\nafter_state=$(protected_state)\nafter_tags=$(git tag --list)\n';
  const provenanceAddition =
    '# Seal the actual package payload before any verification record can attest it.\n' +
    'node "${0:A:h}/beta-package-provenance.mjs" --record >/dev/null\n\n';

  it('compares historical Git blobs independently of the currently checked-out web source', async () => {
    const fixture = repository();
    const packageSha = fixture.agentSha;
    fixture.write('apps/web/src/App.tsx', 'new web');
    fixture.commit();
    const result = await comparePackagedAgentInputs({
      cwd: fixture.cwd,
      packageSha,
      agentRef: 'v8.6.4'
    });
    expect(result).toMatchObject({
      ok: true,
      agentSha: fixture.agentSha,
      packageSha,
      blockers: []
    });
    expect(result.packageInputsDigest).toBe(result.agentInputsDigest);
  });

  it.each([
    'tsconfig.base.json',
    'scripts/stage-agent-runtime.mjs',
    'scripts/package-mac.sh',
    'unknown-build.config.mjs'
  ])('rejects an omitted historical compile/runtime input %s', async name => {
    const fixture = repository();
    fixture.write(name, 'changed agent build input');
    const packageSha = fixture.commit();
    const result = await comparePackagedAgentInputs({
      cwd: fixture.cwd,
      packageSha,
      agentRef: 'v8.6.4'
    });
    expect(result.blockers).toContainEqual({ path: name, code: 'WEB_ONLY_AGENT_INPUT_CHANGED' });
    expect(result.packageInputsDigest).not.toBe(result.agentInputsDigest);
  });

  it('rejects historical root build-script changes, while canonical operator additions preserve the digest', async () => {
    const fixture = repository();
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: { ...fixture.metadata.scripts, 'release:web': 'node scripts/release-web-only.mjs' }
    });
    let packageSha = fixture.commit();
    expect(
      (await comparePackagedAgentInputs({ cwd: fixture.cwd, packageSha, agentRef: 'v8.6.4' })).ok
    ).toBe(true);
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: { ...fixture.metadata.scripts, build: 'node changed-build.mjs' }
    });
    packageSha = fixture.commit();
    expect(
      (await comparePackagedAgentInputs({ cwd: fixture.cwd, packageSha, agentRef: 'v8.6.4' }))
        .blockers
    ).toContainEqual({ path: 'package.json', code: 'WEB_ONLY_PACKAGE_CHANGED' });
  });

  it('normalizes only the exact reviewed beta payload-seal addition', async () => {
    const fixture = repository();
    fixture.write(
      'scripts/package-beta-mac.sh',
      packager.replace('after_tags=', `${provenanceAddition}after_tags=`)
    );
    const packageSha = fixture.commit();
    const result = await comparePackagedAgentInputs({
      cwd: fixture.cwd,
      packageSha,
      agentRef: 'v8.6.4'
    });
    expect(result.ok).toBe(true);
    expect(result.packageInputsDigest).toBe(result.agentInputsDigest);
    expect((await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' })).ok).toBe(true);
  });

  it.each([
    packager.replace('swiftc launcher.swift', 'swiftc modified-launcher.swift'),
    packager.replace(
      'after_tags=',
      `${provenanceAddition.replace('--record', '--record --unsafe')}after_tags=`
    ),
    packager.replace('after_tags=', `${provenanceAddition}${provenanceAddition}after_tags=`)
  ])(
    'rejects compile commands, modified sealer commands and duplicate exemption blocks',
    async content => {
      const fixture = repository();
      fixture.write('scripts/package-beta-mac.sh', content);
      const packageSha = fixture.commit();
      const compared = await comparePackagedAgentInputs({
        cwd: fixture.cwd,
        packageSha,
        agentRef: 'v8.6.4'
      });
      expect(compared.blockers).toContainEqual({
        path: 'scripts/package-beta-mac.sh',
        code: 'WEB_ONLY_AGENT_INPUT_CHANGED'
      });
      const source = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
      expect(source.blockers).toContainEqual({
        path: 'scripts/package-beta-mac.sh',
        code: 'WEB_ONLY_AGENT_INPUT_CHANGED'
      });
    }
  );

  it('does not accept symbolic package refs or missing tagged baselines as provenance', async () => {
    const fixture = repository();
    expect(
      (
        await comparePackagedAgentInputs({
          cwd: fixture.cwd,
          packageSha: 'HEAD',
          agentRef: 'v8.6.4'
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await comparePackagedAgentInputs({
          cwd: fixture.cwd,
          packageSha: fixture.agentSha,
          agentRef: 'missing-tag'
        })
      ).ok
    ).toBe(false);
  });
});

describe('committed web-only source admission', () => {
  it('pins the released tag, clean HEAD, changed paths and unchanged protected input digest', async () => {
    const fixture = repository();
    const baseline = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    fixture.write('apps/web/src/App.tsx', 'export const App = "new";');
    fixture.write('docs/hotfix.md', 'Web-only fix.');
    const sourceSha = fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result).toMatchObject({
      ok: true,
      sourceSha,
      agentSha: fixture.agentSha,
      changedPaths: ['apps/web/src/App.tsx', 'docs/hotfix.md'],
      blockers: [],
      agentInputsDigest: baseline.agentInputsDigest
    });
    expect(result.agentInputsDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('allows only canonical additive operator scripts in root package metadata', async () => {
    const fixture = repository();
    const baseline = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: {
        ...fixture.metadata.scripts,
        'release:web': 'node scripts/release-web-only.mjs',
        'beta:verify:web': 'node scripts/verify-web-only.mjs'
      }
    });
    fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result.ok).toBe(true);
    expect(result.agentInputsDigest).toBe(baseline.agentInputsDigest);
  });

  it.each(['version', 'dependencies', 'workspaces', 'scripts'])(
    'rejects root package %s drift',
    async field => {
      const fixture = repository();
      const changes = {
        version: '8.6.5',
        dependencies: { pg: '9.0.0' },
        workspaces: ['apps/*'],
        scripts: { build: 'node malicious-build.mjs' }
      };
      fixture.write('package.json', {
        ...fixture.metadata,
        [field]: changes[field as keyof typeof changes]
      });
      fixture.commit();
      const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual({
        path: 'package.json',
        code: 'WEB_ONLY_PACKAGE_CHANGED'
      });
    }
  );

  it('rejects noncanonical added shell commands', async () => {
    const fixture = repository();
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: { ...fixture.metadata.scripts, 'release:web': 'npm run package:mac' }
    });
    fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result.blockers).toContainEqual({
      path: 'package.json',
      code: 'WEB_ONLY_PACKAGE_CHANGED'
    });
  });

  it('does not allow editing an operator script already present in the released package', async () => {
    const fixture = repository();
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: { ...fixture.metadata.scripts, 'release:web': 'node scripts/old-release.mjs' }
    });
    fixture.commit();
    fixture.git('tag', 'v8.6.4-with-script');
    fixture.write('package.json', {
      ...fixture.metadata,
      scripts: { ...fixture.metadata.scripts, 'release:web': 'node scripts/release-web-only.mjs' }
    });
    fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4-with-script' });
    expect(result.blockers).toContainEqual({
      path: 'package.json',
      code: 'WEB_ONLY_PACKAGE_CHANGED'
    });
  });

  it('does not treat renamed protected inputs as new allowed web files', async () => {
    const fixture = repository();
    fixture.git('mv', 'apps/agent/src/index.ts', 'apps/web/src/renamed-agent.ts');
    fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result.blockers).toContainEqual({
      path: 'apps/agent/src/index.ts',
      code: 'WEB_ONLY_AGENT_INPUT_CHANGED'
    });
  });

  it('rejects dirty tracked or untracked files and a candidate other than current HEAD', async () => {
    const fixture = repository();
    fixture.write('apps/web/src/App.tsx', 'uncommitted');
    expect(
      (await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' })).blockers
    ).toContainEqual({ path: '.', code: 'WEB_ONLY_SOURCE_DIRTY' });
    fixture.commit();
    expect(
      (await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4', candidateRef: 'v8.6.4' }))
        .blockers
    ).toContainEqual({ path: '.', code: 'WEB_ONLY_CANDIDATE_NOT_HEAD' });
    fixture.write('scratch.txt', 'untracked');
    expect(
      (await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' })).blockers
    ).toContainEqual({ path: '.', code: 'WEB_ONLY_SOURCE_DIRTY' });
  });

  it('requires a tag and rejects a branch that does not descend from it', async () => {
    const fixture = repository();
    expect(
      (await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'HEAD' })).blockers
    ).toContainEqual({ path: '.', code: 'WEB_ONLY_AGENT_TAG_UNPROVEN' });
    fixture.git('checkout', '--quiet', '--orphan', 'unrelated');
    fixture.git('rm', '--quiet', '-rf', '.');
    fixture.write('package.json', fixture.metadata);
    fixture.commit();
    expect(
      (await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' })).blockers
    ).toContainEqual({ path: '.', code: 'WEB_ONLY_ANCESTRY_UNPROVEN' });
  });

  it('rejects committed symlinks even under an otherwise allowed application path', async () => {
    const fixture = repository();
    // core.symlinks=false makes the Git symlink representation portable to
    // Windows without needing administrator privileges to create OS symlinks.
    fixture.git('config', 'core.symlinks', 'false');
    fixture.write('apps/web/src/link.ts', '../../../package.json');
    fixture.git('add', '--all');
    const blob = fixture.git('hash-object', '-w', 'apps/web/src/link.ts');
    fixture.git('update-index', '--cacheinfo', `120000,${blob},apps/web/src/link.ts`);
    fixture.git('commit', '--quiet', '-m', 'symlink fixture');
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result.blockers).toContainEqual({
      path: 'apps/web/src/link.ts',
      code: 'WEB_ONLY_UNSAFE_FILE_MODE'
    });
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects hidden worktree drift via %s',
    async flag => {
      const fixture = repository();
      fixture.git('update-index', flag, 'apps/web/src/App.tsx');
      fixture.write('apps/web/src/App.tsx', 'hidden uncommitted source');
      const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
      expect(result.blockers).toContainEqual({ path: '.', code: 'WEB_ONLY_INDEX_UNTRUSTED' });
    }
  );

  it('permits inherited final manifest bytes only as a path exemption, never as signature/live proof', async () => {
    const fixture = repository();
    fixture.write(
      'apps/web/public/.well-known/wishly/stable.json',
      '{"untrusted":"must be checked against live"}'
    );
    fixture.commit();
    const result = await inspectWebOnlySource({ cwd: fixture.cwd, agentRef: 'v8.6.4' });
    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual(['apps/web/public/.well-known/wishly/stable.json']);
    expect(result).not.toHaveProperty('manifestVerified');
  });
});
