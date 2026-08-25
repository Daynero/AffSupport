import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathGrantLedger, IDLE_GRANT_TTL_MS } from '../apps/agent/src/files/path-grants.js';

/**
 * C3. The ledger exists so the session token stops being a key to the whole
 * disk, and the interesting failures are not "someone guessed a grant id".
 *
 * They are the ordinary ones: a path that resolves somewhere else than it looks,
 * a file swapped after it was approved, a directory grant quietly becoming a
 * licence to write anywhere under it. Each of those is tested here against a
 * real filesystem, because every one of them is a question about what the
 * operating system does rather than what the code intends.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-grants-'));
  directories.push(directory);
  return directory;
}

describe('what a grant authorises', () => {
  it('authorises the file it was minted for', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    const ledger = new PathGrantLedger();

    expect(ledger.mint(file)).not.toBeNull();
    expect(ledger.authorises(file, 'read')).toBe(true);
  });

  it('does not authorise its neighbour', async () => {
    const root = await workspace();
    const granted = path.join(root, 'clip.mov');
    const neighbour = path.join(root, 'private.mov');
    await writeFile(granted, 'video');
    await writeFile(neighbour, 'secret');
    const ledger = new PathGrantLedger();
    ledger.mint(granted);

    // A file grant is a grant for that file. Anything looser makes "choose a
    // file" mean "choose a folder", which is not what the user was asked.
    expect(ledger.authorises(neighbour, 'read')).toBe(false);
  });

  it('covers descendants of a granted directory', async () => {
    const root = await workspace();
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const file = path.join(nested, 'clip.mov');
    await writeFile(file, 'video');
    const ledger = new PathGrantLedger();
    ledger.mint(root, { origin: 'picker' });

    expect(ledger.authorises(file, 'read')).toBe(true);
  });

  it('refuses traversal out of a granted directory', async () => {
    const root = await workspace();
    const inside = path.join(root, 'inside');
    await mkdir(inside);
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'not yours');
    const ledger = new PathGrantLedger();
    ledger.mint(inside);

    // The path is resolved before comparison, so `inside/../outside.txt` is
    // compared as `outside.txt` and refused.
    expect(ledger.authorises(path.join(inside, '..', 'outside.txt'), 'read')).toBe(false);
  });

  it('never lets a read grant authorise a write', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    const ledger = new PathGrantLedger();
    ledger.mint(file, { access: 'read' });

    // "Let me read this" and "let me overwrite this" are different questions,
    // and the user only answered one of them.
    expect(ledger.authorises(file, 'read')).toBe(true);
    expect(ledger.authorises(file, 'write')).toBe(false);
  });

  it('lets a write grant satisfy a read', async () => {
    const root = await workspace();
    const file = path.join(root, 'out.mp4');
    await writeFile(file, 'video');
    const ledger = new PathGrantLedger();
    ledger.mint(file, { access: 'write' });

    expect(ledger.authorises(file, 'read')).toBe(true);
  });
});

describe('a path that is not what it looks like', () => {
  it('grants the target of a symlink, not the link', async () => {
    const root = await workspace();
    const real = path.join(root, 'real.mov');
    const link = path.join(root, 'link.mov');
    await writeFile(real, 'video');
    await symlink(real, link);
    const ledger = new PathGrantLedger();

    const grant = ledger.mint(link);
    // Resolved at mint, so everything downstream compares against where the
    // link actually leads.
    expect(grant?.path).toBe(await realpathOf(real));
  });

  it('refuses a file swapped after it was approved', async () => {
    const root = await workspace();
    const approved = path.join(root, 'approved.mov');
    const secret = path.join(root, 'secret.txt');
    await writeFile(approved, 'video');
    await writeFile(secret, 'credentials');
    const ledger = new PathGrantLedger();
    ledger.mint(approved);
    expect(ledger.authorises(approved, 'read')).toBe(true);

    // The realistic attack: a job sits in the queue for minutes between the
    // grant and the read, and the name is repointed in that window. The name
    // still matches; the file behind it does not.
    await unlink(approved);
    await symlink(secret, approved);
    expect(ledger.authorises(approved, 'read')).toBe(false);
  });

  it('refuses a path that no longer exists', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    const ledger = new PathGrantLedger();
    ledger.mint(file);
    await unlink(file);

    expect(ledger.authorises(file, 'read')).toBe(false);
  });
});

describe('the outer bound', () => {
  it.each([
    ['an ssh directory', path.join(os.homedir(), '.ssh')],
    ['a keychain', path.join(os.homedir(), 'Library', 'Keychains')],
    ['a system directory', process.platform === 'win32' ? 'C:\\Windows' : '/etc']
  ])('refuses to mint a grant for %s', (_why, target) => {
    const ledger = new PathGrantLedger();
    // Applied at mint *and* at use, so a ledger bug degrades to "something in
    // the user's own documents" rather than "anything at all".
    expect(ledger.mint(target)).toBeNull();
    expect(ledger.authorises(target, 'read')).toBe(false);
  });
});

describe('lifetime', () => {
  it('lets an unreferenced grant age out', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    let at = 1_000_000;
    const ledger = new PathGrantLedger(() => at);
    ledger.mint(file);

    at += IDLE_GRANT_TTL_MS + 1;
    expect(ledger.authorises(file, 'read')).toBe(false);
  });

  it('keeps a grant that durable state still points at', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    let at = 1_000_000;
    const ledger = new PathGrantLedger(() => at);
    ledger.mint(file, { referenced: true });

    // A queued job may sit for days. Expiring the grant under it would turn a
    // resumed queue into a permission error the user cannot act on.
    at += IDLE_GRANT_TTL_MS * 10;
    expect(ledger.authorises(file, 'read')).toBe(true);
  });

  it('resumes ageing once the last reference goes', async () => {
    const root = await workspace();
    const file = path.join(root, 'clip.mov');
    await writeFile(file, 'video');
    let at = 1_000_000;
    const ledger = new PathGrantLedger(() => at);
    const grant = ledger.mint(file, { referenced: true })!;

    ledger.release(grant.id);
    at += IDLE_GRANT_TTL_MS + 1;
    expect(ledger.authorises(file, 'read')).toBe(false);
  });
});

async function realpathOf(candidate: string) {
  const { realpath } = await import('node:fs/promises');
  return realpath(candidate);
}

describe('observe mode', () => {
  /**
   * A new authorisation check turned straight on is how a security fix becomes
   * an outage: every path the ledger fails to account for is a user whose file
   * stops working, and the ways it can fail are exactly the ways nobody thought
   * of. So it counts first and refuses later — but only if the counting is real
   * and the switch actually flips, which is what these assert. An observe mode
   * nobody can turn off is a check that never happens.
   */

  it('allows what it would refuse, and counts it', async () => {
    const root = await workspace();
    const ungranted = path.join(root, 'never-chosen.mov');
    await writeFile(ungranted, 'video');
    const ledger = new PathGrantLedger();

    expect(ledger.check(ungranted, 'read')).toBe(true);
    expect(ledger.wouldRefuseCount()).toBe(1);
  });

  it('refuses once enforcing', async () => {
    const root = await workspace();
    const ungranted = path.join(root, 'never-chosen.mov');
    await writeFile(ungranted, 'video');
    const ledger = new PathGrantLedger();
    ledger.setEnforcing(true);

    expect(ledger.check(ungranted, 'read')).toBe(false);
  });

  it('counts nothing when the path is granted', async () => {
    const root = await workspace();
    const granted = path.join(root, 'chosen.mov');
    await writeFile(granted, 'video');
    const ledger = new PathGrantLedger();
    ledger.mint(granted);

    expect(ledger.check(granted, 'read')).toBe(true);
    // The number is the whole signal for when it is safe to enforce; counting
    // an allowed path would make it meaningless.
    expect(ledger.wouldRefuseCount()).toBe(0);
  });

  it('still refuses an out-of-bounds path while only observing', async () => {
    const ledger = new PathGrantLedger();
    // The outer bound is not a ledger decision and does not wait for enforcement:
    // observe mode exists to protect users from an incomplete ledger, not to
    // hand out credential directories in the meantime.
    expect(ledger.authorises(path.join(os.homedir(), '.ssh', 'id_rsa'), 'read')).toBe(false);
  });
});
