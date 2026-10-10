import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * C1, SC-010. The macOS signing chain: inside-out signatures, hardened runtime, a minimal
 * entitlement set, and — with a real identity — Gatekeeper acceptance and a stapled ticket.
 *
 * What this file can prove on any Mac, and what it cannot:
 *
 * - The **verifier** below is complete and runs everywhere: it walks a bundle, finds every
 *   Mach-O, and checks each one's signature, hardened-runtime flag and the bundle's
 *   entitlements, then checks the whole bundle strictly. Its negative controls run today:
 *   the ad-hoc chain `scripts/package-mac.sh` ships is rejected, and so is a bundle tampered
 *   with after signing.
 * - The **chain under test** is `scripts/sign-mac-app.sh` (T157). Until it exists those cases
 *   are skipped by name, not passed — the skip message is the outstanding work.
 * - A **self-signed identity in a throwaway keychain** needs `security create-keychain`, which
 *   adds the new keychain to the user's search list — a change to the machine's keychain
 *   configuration this suite will not make on a developer's Mac. Instead the identity is
 *   injected: set `SOTY_TEST_SIGNING_IDENTITY` (and `SOTY_TEST_SIGNING_KEYCHAIN` for a keychain
 *   file outside the search list) on a CI runner that provisions one. Without it the chain is
 *   exercised with the ad-hoc identity, which proves structure but not trust.
 * - **Gatekeeper and stapling** need Apple's notary service and a Developer ID. They run only
 *   with `SOTY_TEST_EXPECT_NOTARIZED=1`; that substitution is the one step SC-010 leaves open.
 */

const run = promisify(execFile);
const isMac = process.platform === 'darwin';
const CHAIN = path.resolve('scripts/sign-mac-app.sh');
const chainExists = existsSync(CHAIN);
const identity = process.env.SOTY_TEST_SIGNING_IDENTITY ?? '-';
const keychain = process.env.SOTY_TEST_SIGNING_KEYCHAIN ?? null;
const expectNotarized = process.env.SOTY_TEST_EXPECT_NOTARIZED === '1';

/**
 * Entitlements a Node-hosting app must never carry: each one switches off a protection the
 * hardened runtime exists to provide, and none is needed to spawn FFmpeg or run JavaScript.
 */
const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.get-task-allow'
];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

/** A bundle shaped like Soty's: a launcher, a bundled runtime, and a helper binary. */
async function fixtureBundle(): Promise<{ app: string; nested: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-signing-'));
  directories.push(root);
  const app = path.join(root, 'Fixture.app');
  const contents = path.join(app, 'Contents');
  const launcher = path.join(contents, 'MacOS', 'Fixture');
  const runtime = path.join(contents, 'Resources', 'runtime', 'node');
  const helper = path.join(contents, 'Resources', 'bin', 'ffmpeg');
  for (const file of [launcher, runtime, helper])
    await mkdir(path.dirname(file), { recursive: true });
  // Small, always-present Mach-O executables stand in for the real ones; what is checked is
  // the signature on them, not what they do.
  await copyFile('/usr/bin/true', launcher);
  await copyFile('/bin/echo', runtime);
  await copyFile('/bin/echo', helper);
  for (const file of [launcher, runtime, helper]) await chmod(file, 0o755);
  await writeFile(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>test.soty.signing-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
  );
  return { app, nested: [runtime, helper] };
}

async function isMachO(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buffer.readUInt32BE(0);
    return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  } finally {
    await handle.close();
  }
}

async function machOFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (await isMachO(file)) found.push(file);
  }
  return found;
}

async function codesign(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run('codesign', args);
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/**
 * Every problem with a signed bundle, or none. This is the acceptance check the chain must
 * pass; an empty list is the only success.
 */
async function signingProblems(
  app: string,
  options: { requireTrustedIdentity: boolean }
): Promise<string[]> {
  const problems: string[] = [];
  const binaries = await machOFiles(app);
  if (!binaries.length) problems.push('no Mach-O binaries found');
  for (const binary of binaries) {
    const name = path.relative(app, binary);
    const verified = await codesign(['--verify', '--strict', binary]);
    if (!verified.ok) {
      problems.push(`${name}: signature invalid`);
      continue;
    }
    const details = await codesign(['-dvv', binary]);
    if (!/flags=0x[0-9a-f]*\([^)]*\bruntime\b[^)]*\)/u.test(details.output)) {
      problems.push(`${name}: hardened runtime is off`);
    }
    if (options.requireTrustedIdentity) {
      if (/Signature=adhoc/u.test(details.output)) problems.push(`${name}: ad-hoc signature`);
      if (!/Timestamp=/u.test(details.output)) problems.push(`${name}: no secure timestamp`);
    }
  }
  const deep = await codesign(['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (!deep.ok) problems.push(`bundle: ${deep.output.trim().split('\n').at(-1) ?? 'invalid'}`);
  const entitlements = await codesign(['-d', '--entitlements', '-', '--xml', app]);
  for (const key of FORBIDDEN_ENTITLEMENTS) {
    if (entitlements.output.includes(key)) problems.push(`bundle: carries ${key}`);
  }
  return problems;
}

/** The two codesign calls `scripts/package-mac.sh` makes today, applied to the fixture. */
async function signLikePackageMacToday(app: string, nested: string[]) {
  for (const file of nested) await codesign(['--force', '--sign', '-', file]);
  await codesign(['--force', '--deep', '--preserve-metadata=entitlements', '--sign', '-', app]);
}

async function runChain(app: string) {
  return run('zsh', [CHAIN, app], {
    env: {
      ...process.env,
      SOTY_SIGNING_IDENTITY: identity,
      ...(keychain ? { SOTY_SIGNING_KEYCHAIN: keychain } : {}),
      // The chain must not reach Apple unless the run is meant to be notarized.
      ...(expectNotarized ? {} : { SOTY_SKIP_NOTARIZATION: '1' })
    }
  });
}

describe.skipIf(!isMac)('the signing verifier has teeth', () => {
  it('rejects the ad-hoc chain package-mac.sh ships today', async () => {
    // C1 itself: an ad-hoc signature with the hardened runtime off. This is the bundle users
    // are currently told to right-click past Gatekeeper.
    const { app, nested } = await fixtureBundle();
    await signLikePackageMacToday(app, nested);
    const problems = await signingProblems(app, { requireTrustedIdentity: true });
    expect(problems.some(problem => problem.includes('hardened runtime is off'))).toBe(true);
    expect(problems.some(problem => problem.includes('ad-hoc signature'))).toBe(true);
  });

  it('confirms package-mac.sh still signs ad-hoc, so the gap above is the shipped one', async () => {
    const script = await readFile('scripts/package-mac.sh', 'utf8');
    const delegates = script.includes('sign-mac-app.sh');
    // Once T158 routes packaging through the chain, this flips and the chain cases below
    // are what guard the shipped bundle.
    expect(delegates || /codesign[^\n]*--sign -/u.test(script)).toBe(true);
  });

  it('rejects a bundle whose nested binary changed after signing', async () => {
    const { app, nested } = await fixtureBundle();
    for (const file of nested)
      await codesign(['--force', '--options', 'runtime', '--sign', '-', file]);
    await codesign(['--force', '--options', 'runtime', '--sign', '-', app]);
    expect(await signingProblems(app, { requireTrustedIdentity: false })).toEqual([]);

    const handle = await open(nested[0]!, 'r+');
    try {
      // A byte in the middle of the code, not in the signature blob at the end.
      const { size } = await handle.stat();
      const offset = Math.floor(size / 2);
      const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, offset);
      await handle.write(Buffer.from([buffer[0]! ^ 0xff]), 0, 1, offset);
    } finally {
      await handle.close();
    }
    const problems = await signingProblems(app, { requireTrustedIdentity: false });
    // Caught twice over: the binary's own page hashes and the bundle's seal over it.
    expect(problems.length, problems.join('; ')).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/runtime\/node|bundle:/u);
  });

  it('rejects a bundle signed outside-in, leaving a nested binary unsigned', async () => {
    const { app, nested } = await fixtureBundle();
    for (const file of nested) await codesign(['--remove-signature', file]);
    // Signing only the outer bundle — no `--deep` — seals the nested files' hashes into the
    // bundle but leaves each Mach-O without a signature of its own.
    await codesign(['--force', '--options', 'runtime', '--sign', '-', app]);
    const problems = await signingProblems(app, { requireTrustedIdentity: false });
    expect(problems.some(problem => problem.includes('signature invalid'))).toBe(true);
  });

  it('rejects an entitlement that switches off library validation', async () => {
    const { app, nested } = await fixtureBundle();
    const entitlements = path.join(path.dirname(app), 'loose.entitlements');
    await writeFile(
      entitlements,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`
    );
    for (const file of nested)
      await codesign(['--force', '--options', 'runtime', '--sign', '-', file]);
    await codesign([
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      '--sign',
      '-',
      app
    ]);
    expect(await signingProblems(app, { requireTrustedIdentity: false })).toContain(
      'bundle: carries com.apple.security.cs.disable-library-validation'
    );
  });
});

describe.skipIf(!isMac)('the signing chain (scripts/sign-mac-app.sh)', () => {
  it.skipIf(!chainExists)(
    'signs inside-out with the hardened runtime and a minimal entitlement set',
    async () => {
      const { app } = await fixtureBundle();
      await runChain(app);
      expect(await signingProblems(app, { requireTrustedIdentity: identity !== '-' })).toEqual([]);
    },
    120_000
  );

  it.skipIf(!chainExists || !expectNotarized)(
    'produces a bundle Gatekeeper accepts, with the notarization ticket stapled',
    async () => {
      const { app } = await fixtureBundle();
      await runChain(app);
      await expect(run('spctl', ['--assess', '--type', 'execute', app])).resolves.toBeDefined();
      await expect(run('xcrun', ['stapler', 'validate', app])).resolves.toBeDefined();
    },
    900_000
  );

  it.skipIf(chainExists)(
    'is not implemented yet (T157): scripts/sign-mac-app.sh does not exist',
    () => {
      // Recorded rather than silently absent: this case disappears the day the chain lands.
      expect(chainExists).toBe(false);
    }
  );
});
