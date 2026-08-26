import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from './support/temp-dir.js';

const platform = vi.hoisted(() => ({
  root: '',
  migrates: true,
  renameFails: false
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (platform.renameFails) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return actual.renameSync(from, to);
    }
  };
});

vi.mock('../apps/agent/src/platform/platform.js', () => ({
  appSupportRoot: () => platform.root,
  legacySupportDirectoryMigration: () => platform.migrates
}));

const { applicationSupportRoot } = await import('../apps/agent/src/files/support-dir.js');

let cleanup: (() => Promise<void>) | null = null;
const savedOverride = process.env.AGENT_SUPPORT_DIRECTORY_NAME;

beforeEach(async () => {
  const directory = await temporaryDirectory('support-dir-');
  platform.root = directory.path;
  platform.migrates = true;
  platform.renameFails = false;
  cleanup = directory.cleanup;
  delete process.env.AGENT_SUPPORT_DIRECTORY_NAME;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  if (savedOverride === undefined) delete process.env.AGENT_SUPPORT_DIRECTORY_NAME;
  else process.env.AGENT_SUPPORT_DIRECTORY_NAME = savedOverride;
});

describe('where the agent keeps its state', () => {
  it('uses the current brand directory when nothing overrides it', () => {
    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty'));
  });

  it('honours an override that is a single directory name', () => {
    process.env.AGENT_SUPPORT_DIRECTORY_NAME = 'Soty-test-run';

    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty-test-run'));
  });
});

/**
 * The override is joined onto the user's Application Support directory, so a
 * value carrying a separator does not name a directory — it relocates every
 * state file the agent writes. Each of these is ignored rather than sanitised,
 * because quietly rewriting a caller's configuration to a different directory
 * is worse than not honouring it.
 */
describe('an override that is not a single directory name', () => {
  it.each([
    ['climbs out with ..', '..'],
    ['climbs out with a relative path', '../../../../etc'],
    ['is the current directory', '.'],
    ['carries a forward slash', 'Soty/state'],
    ['carries a backslash', 'Soty\\state'],
    ['is an absolute path', '/tmp/somewhere-else'],
    ['is empty', ''],
    ['is only whitespace', '   ']
  ])('ignores an override that %s', (_case, value) => {
    process.env.AGENT_SUPPORT_DIRECTORY_NAME = value;

    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty'));
  });
});

/**
 * State written under the pre-rebrand names has to survive the upgrade, or a
 * user's queue, managed images and estimate cache silently become someone
 * else's — a fresh empty directory beside the one holding their work.
 */
describe('adopting the directory an older build wrote', () => {
  it.each(['Wishly', 'Local Video Compressor'])('renames %s into place', legacyName => {
    const legacy = path.join(platform.root, legacyName);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'queue.json'), '{"jobs":[]}');

    const resolved = applicationSupportRoot();

    expect(resolved).toBe(path.join(platform.root, 'Soty'));
    expect(existsSync(path.join(resolved, 'queue.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('leaves an existing current directory alone', () => {
    const legacy = path.join(platform.root, 'Wishly');
    const current = path.join(platform.root, 'Soty');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'queue.json'), '{"jobs":["old"]}');
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(current, 'queue.json'), '{"jobs":["current"]}');

    applicationSupportRoot();

    // Both survive: adopting the legacy one here would replace state the
    // current build is already using.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(path.join(current, 'queue.json'))).toBe(true);
  });

  it('does not migrate on a system that never had those names', () => {
    platform.migrates = false;
    const legacy = path.join(platform.root, 'Wishly');
    mkdirSync(legacy, { recursive: true });

    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty'));
    expect(existsSync(legacy)).toBe(true);
  });

  it('skips migration when an override already names the directory', () => {
    process.env.AGENT_SUPPORT_DIRECTORY_NAME = 'Soty-test-run';
    const legacy = path.join(platform.root, 'Wishly');
    mkdirSync(legacy, { recursive: true });

    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty-test-run'));
    expect(existsSync(legacy)).toBe(true);
  });

  it('survives a rename it is not allowed to make', () => {
    platform.renameFails = true;
    const legacy = path.join(platform.root, 'Wishly');
    mkdirSync(legacy, { recursive: true });

    // Best-effort: the caller still gets a usable path, and the directory is
    // created on demand later. A migration that cannot be performed must not
    // stop the agent from starting.
    expect(applicationSupportRoot()).toBe(path.join(platform.root, 'Soty'));
    expect(existsSync(legacy)).toBe(true);
  });
});
