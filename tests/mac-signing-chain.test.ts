import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { afterEach, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';

/**
 * 048 (FR-001, FR-002, FR-007, FR-008), descended from 009 C1/SC-010. The macOS signing
 * chain: inside-out signatures, hardened runtime, one measured entitlement profile per
 * binary, and — with a real identity — Gatekeeper acceptance and a stapled ticket.
 *
 * What this file can prove on any Mac, and what it cannot:
 *
 * - The **verifier** below runs everywhere: it walks a bundle, finds every Mach-O, checks
 *   each one's signature, hardened-runtime flag and entitlements against the profile its
 *   path selects, then checks the whole bundle strictly. Its negative controls run today:
 *   the ad-hoc chain `scripts/package-mac.sh` ships is rejected, and so is a bundle tampered
 *   with after signing.
 * - The **chain under test** is `scripts/sign-mac-app.sh`. The fixture is made of tiny
 *   platform binaries, so it proves structure, not that a JIT survives the hardened runtime.
 *   That proof needs a real static Node: set `SOTY_TEST_NODE_BINARY` to one (the official
 *   nodejs.org tarball's `bin/node`) and two more cases run — the chain-signed Node executes
 *   JavaScript and WebAssembly, and the same Node hardened *without* the JIT pair does not
 *   start. Measured 2026-11-09 on arm64 and x64: specs/048-macos-apple-trust/research.md.
 * - A **self-signed identity in a throwaway keychain** needs `security create-keychain`, which
 *   adds the new keychain to the user's search list — a change to the machine's keychain
 *   configuration this suite will not make on a developer's Mac. Instead the identity is
 *   injected: set `SOTY_TEST_SIGNING_IDENTITY` (and `SOTY_TEST_SIGNING_KEYCHAIN` for a keychain
 *   file outside the search list) on a runner that provisions one. Without it the chain is
 *   exercised with the ad-hoc identity, which proves structure but not trust.
 * - **Gatekeeper and stapling** need Apple's notary service and a Developer ID. They run only
 *   with `SOTY_TEST_EXPECT_NOTARIZED=1`; that substitution is the one step SC-010 leaves open.
 */

const run = promisify(execFile);
const macHost = requirePlatform('darwin');
const CHAIN = path.resolve('scripts/sign-mac-app.sh');
const NODE_ENTITLEMENTS = path.resolve('packaging/macos/entitlements/node.plist');
const chainExists = existsSync(CHAIN);
const identity = process.env.SOTY_TEST_SIGNING_IDENTITY ?? '-';
const keychain = process.env.SOTY_TEST_SIGNING_KEYCHAIN ?? null;
const expectNotarized = process.env.SOTY_TEST_EXPECT_NOTARIZED === '1';
const realNode = process.env.SOTY_TEST_NODE_BINARY ?? null;

/**
 * Entitlements no binary in the bundle may carry: each one switches off a protection the
 * hardened runtime exists to provide, and `get-task-allow` is refused by notarization.
 * Measured: Node and Chromium run without all four.
 */
const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.get-task-allow'
];

/**
 * The two entitlements a V8 host needs under the hardened runtime, and the only two the
 * `node` and `chromium` profiles grant. arm64 Node starts with either; x64 Node needs the
 * second; both profiles carry both so one bundle layout serves both architectures.
 */
const REQUIRED_JIT_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory'
].sort();

/** A JIT host, by the same path rule the chain uses to pick its profile. */
function runsAJit(app: string, binary: string): boolean {
  return (
    path.relative(app, binary) === path.join('Contents', 'Resources', 'runtime', 'node') ||
    path.basename(binary) === 'chrome-headless-shell'
  );
}

/** Exercises the optimizing JIT and the WebAssembly compiler, then reports. */
const JIT_PROBE =
  'let s=0;for(let i=0;i<5e6;i++)s+=i%7;' +
  'const w=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));' +
  'process.stdout.write(`ok ${s} ${process.arch} ${w instanceof WebAssembly.Module}`)';

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

function entitlementKeys(xml: string): string[] {
  return [...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map(match => match[1]!).sort();
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
    const entitlements = entitlementKeys(
      (await codesign(['-d', '--entitlements', '-', '--xml', binary])).output
    );
    for (const key of FORBIDDEN_ENTITLEMENTS) {
      if (entitlements.includes(key)) problems.push(`${name}: carries ${key}`);
    }
    if (runsAJit(app, binary)) {
      if (entitlements.join('\n') !== REQUIRED_JIT_ENTITLEMENTS.join('\n'))
        problems.push(`${name}: entitlements must be exactly the JIT pair`);
    } else {
      for (const key of REQUIRED_JIT_ENTITLEMENTS) {
        if (entitlements.includes(key)) problems.push(`${name}: carries ${key} without a JIT`);
      }
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

/** The two codesign calls `scripts/package-mac.sh` made before 048, applied to the fixture. */
async function signLikePre048Packaging(app: string, nested: string[]) {
  for (const file of nested) await codesign(['--force', '--sign', '-', file]);
  await codesign(['--force', '--deep', '--preserve-metadata=entitlements', '--sign', '-', app]);
}

/**
 * A correct hardened bundle made without the chain, so the verifier's own controls do not
 * depend on the code they guard: inside-out, hardened, the JIT pair only where a JIT runs.
 */
async function signHardenedByHand(app: string, nested: string[]) {
  for (const file of nested) {
    const args = ['--force', '--options', 'runtime'];
    if (runsAJit(app, file)) args.push('--entitlements', NODE_ENTITLEMENTS);
    await codesign([...args, '--sign', '-', file]);
  }
  await codesign(['--force', '--options', 'runtime', '--sign', '-', app]);
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

describeRequiring(macHost, 'the signing verifier has teeth', () => {
  it('rejects the ad-hoc signing every release before 048 shipped', async () => {
    // C1 itself: an ad-hoc signature with the hardened runtime off. This is the bundle users
    // were told to clear quarantine on by hand up to 1.4.x.
    const { app, nested } = await fixtureBundle();
    await signLikePre048Packaging(app, nested);
    const problems = await signingProblems(app, { requireTrustedIdentity: true });
    expect(problems.some(problem => problem.includes('hardened runtime is off'))).toBe(true);
    expect(problems.some(problem => problem.includes('ad-hoc signature'))).toBe(true);
    expect(problems.some(problem => problem.includes('exactly the JIT pair'))).toBe(true);
  });

  it('confirms every packager delegates to the chain instead of signing ad-hoc itself (048 T010)', async () => {
    const production = await readFile('scripts/package-mac.sh', 'utf8');
    expect(production).toContain('zsh scripts/sign-mac-app.sh "$app" > "$root/signing.json"');
    expect(production).not.toMatch(/codesign[^\n]*--sign -/u);
    // An ad-hoc production package is the owner's explicit pre-048 choice, never a fallback.
    expect(production).toContain('SOTY_MACOS_TRUST_POLICY:-}" == adhoc-pre-048');
    for (const packager of ['scripts/package-dev-mac.sh', 'scripts/package-beta-mac.sh']) {
      const text = await readFile(packager, 'utf8');
      expect(text).toContain(
        'SOTY_SIGNING_IDENTITY=- SOTY_SKIP_NOTARIZATION=1 zsh scripts/sign-mac-app.sh "$app" > "$root/signing.json"'
      );
      expect(text).not.toMatch(/codesign[^\n]*--sign -/u);
    }
    // The image is signed, notarized and stapled on its own, and hashed only after that.
    const image = await readFile('scripts/package-dmg.sh', 'utf8');
    expect(image).toContain('xcrun stapler staple "$dmg"');
    expect(image.indexOf('xcrun stapler staple "$dmg"')).toBeLessThan(
      image.indexOf('shasum -a 256')
    );
  });

  it('accepts a hardened bundle signed by hand with the JIT pair only on the runtime', async () => {
    const { app, nested } = await fixtureBundle();
    await signHardenedByHand(app, nested);
    expect(await signingProblems(app, { requireTrustedIdentity: false })).toEqual([]);
  });

  it('rejects a bundle whose nested binary changed after signing', async () => {
    const { app, nested } = await fixtureBundle();
    await signHardenedByHand(app, nested);
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

  it('rejects a JIT entitlement on a binary that runs no JIT', async () => {
    const { app, nested } = await fixtureBundle();
    for (const file of nested) {
      // The helper gets the runtime's profile: more than ffmpeg needs.
      await codesign([
        '--force',
        '--options',
        'runtime',
        '--entitlements',
        NODE_ENTITLEMENTS,
        '--sign',
        '-',
        file
      ]);
    }
    await codesign(['--force', '--options', 'runtime', '--sign', '-', app]);
    const problems = await signingProblems(app, { requireTrustedIdentity: false });
    expect(problems).toContain(
      'Contents/Resources/bin/ffmpeg: carries com.apple.security.cs.allow-jit without a JIT'
    );
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
    await signHardenedByHand(app, nested);
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

describeRequiring(macHost, 'the signing chain (scripts/sign-mac-app.sh)', () => {
  it.skipIf(!chainExists)(
    'signs inside-out with the hardened runtime and one measured profile per binary',
    async () => {
      const { app } = await fixtureBundle();
      const { stdout } = await runChain(app);
      expect(await signingProblems(app, { requireTrustedIdentity: identity !== '-' })).toEqual([]);
      const summary = JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
      expect(summary).toMatchObject({
        identity: identity === '-' ? 'adhoc' : 'developer-id',
        machO: 3,
        profiles: { node: 1, chromium: 0, hardened: 1 },
        notarized: expectNotarized,
        stapled: expectNotarized
      });
      // Apple's receipt travels with the summary; without notarization there is none.
      expect(summary.submissionId).toEqual(
        expectNotarized ? expect.stringMatching(/^[0-9a-f-]{36}$/u) : null
      );
      // The chain attests each Mach-O it signed: the bytes it received and the bytes it
      // left, so a verifier can tie a re-signed binary back to its recorded source.
      const files = summary.files as {
        path: string;
        profile: string;
        before: string;
        after: string;
      }[];
      expect(files.map(file => [file.path, file.profile])).toEqual([
        ['Contents/MacOS/Fixture', 'launcher'],
        ['Contents/Resources/bin/ffmpeg', 'hardened'],
        ['Contents/Resources/runtime/node', 'node']
      ]);
      const sha256 = async (file: string) =>
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
      for (const file of files) {
        expect(file.before).toMatch(/^[a-f0-9]{64}$/u);
        expect(file.after).toEqual(await sha256(path.join(app, file.path)));
        expect(file.after).not.toEqual(file.before);
      }
      // The fixture's runtime was the unsigned copy of /bin/echo the bundle was built from.
      expect(files.find(file => file.profile === 'node')?.before).toEqual(
        await sha256('/bin/echo')
      );
    },
    120_000
  );

  it.skipIf(!chainExists)('refuses to reach Apple with the ad-hoc identity', async () => {
    const { app } = await fixtureBundle();
    await expect(
      run('zsh', [CHAIN, app], {
        env: { ...process.env, SOTY_SIGNING_IDENTITY: '-', SOTY_SKIP_NOTARIZATION: '' }
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('SIGN_ADHOC_CANNOT_NOTARIZE') });
  });

  it.skipIf(!chainExists)(
    'stops with a closed code before the first codesign call when a trust input is missing',
    async () => {
      // 048 FR-006: a missing input is refused up front, not discovered after a build.
      // All three refusals happen before the chain touches a binary, so they need no
      // certificate; the runtime's CDHash proves nothing was re-signed on the way.
      const { app } = await fixtureBundle();
      const runtime = path.join(app, 'Contents', 'Resources', 'runtime', 'node');
      const cdhash = async () =>
        (await codesign(['-dvv', runtime])).output.match(/^CDHash=(\S+)/mu)?.[1] ?? null;
      const before = await cdhash();
      const base = { ...process.env, SOTY_SIGNING_IDENTITY: '-', SOTY_SKIP_NOTARIZATION: '1' };
      await expect(
        run('zsh', [CHAIN, app], {
          env: {
            ...base,
            SOTY_SIGNING_IDENTITY: 'Developer ID Application: Fixture (ABCDEFGHIJ)',
            SOTY_SKIP_NOTARIZATION: '',
            SOTY_NOTARY_KEYCHAIN_PROFILE: ''
          }
        })
      ).rejects.toMatchObject({ stderr: expect.stringContaining('NOTARY_PROFILE_REQUIRED') });
      const empty = await mkdtemp(path.join(os.tmpdir(), 'soty-no-profiles-'));
      directories.push(empty);
      await expect(
        run('zsh', [CHAIN, app], { env: { ...base, SOTY_ENTITLEMENTS_DIR: empty } })
      ).rejects.toMatchObject({ stderr: expect.stringContaining('SIGN_ENTITLEMENTS_MISSING') });
      await expect(run('zsh', [CHAIN, empty], { env: base })).rejects.toMatchObject({
        stderr: expect.stringContaining('SIGN_INPUT_INVALID')
      });
      expect(await cdhash()).toBe(before);
    }
  );

  it.skipIf(!chainExists)(
    'strips a foreign signature and its entitlements before signing',
    async () => {
      const { app } = await fixtureBundle();
      const node = path.join(app, 'Contents', 'Resources', 'runtime', 'node');
      const loose = path.join(path.dirname(app), 'foreign.entitlements');
      await writeFile(
        loose,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.get-task-allow</key><true/>
<key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
`
      );
      // What the official Node tarball looks like: already signed, with entitlements the
      // distribution must not carry.
      await codesign(['--force', '--entitlements', loose, '--sign', '-', node]);
      await runChain(app);
      expect(await signingProblems(app, { requireTrustedIdentity: identity !== '-' })).toEqual([]);
    }
  );

  it.skipIf(!chainExists || !realNode)(
    'a static Node signed by the chain still runs JavaScript and WebAssembly under the hardened runtime [needs: env:SOTY_TEST_NODE_BINARY]',
    async () => {
      const { app } = await fixtureBundle();
      const node = path.join(app, 'Contents', 'Resources', 'runtime', 'node');
      await copyFile(realNode!, node);
      await chmod(node, 0o755);
      await runChain(app);
      expect(await signingProblems(app, { requireTrustedIdentity: identity !== '-' })).toEqual([]);
      const { stdout } = await run(node, ['-e', JIT_PROBE]);
      expect(stdout).toMatch(/^ok \d+ (?:arm64|x64) true$/u);
    },
    180_000
  );

  it.skipIf(!realNode)(
    'the same Node hardened without the JIT pair does not start, so the pair is measured, not copied [needs: env:SOTY_TEST_NODE_BINARY]',
    async () => {
      // Deliberately outside any .app directory. A hardened binary that traps inside a
      // bundle carrying an Info.plist is held suspended by the crash handler while it
      // consults Launch Services about a bundle nobody registered, for tens of seconds,
      // and is then killed instead of reported; in a bare directory the trap is delivered
      // at once (measured 2026-11-09). The control only needs the binary, not the bundle.
      const root = await mkdtemp(path.join(os.tmpdir(), 'soty-jit-control-'));
      directories.push(root);
      const node = path.join(root, 'node');
      await copyFile(realNode!, node);
      await chmod(node, 0o755);
      await codesign(['--remove-signature', node]);
      await codesign(['--force', '--options', 'runtime', '--sign', '-', node]);
      // V8 cannot map executable memory and traps during isolate creation, before any
      // script runs. A kill by the timeout below would carry SIGTERM instead, so a hang is
      // told apart from the crash this control exists to show.
      await expect(run(node, ['-e', JIT_PROBE], { timeout: 60_000 })).rejects.toMatchObject({
        signal: expect.stringMatching(/^SIG(?:TRAP|ABRT|ILL|SEGV|BUS|KILL)$/u)
      });
    },
    120_000
  );

  it.skipIf(!chainExists || !expectNotarized)(
    'produces a bundle Gatekeeper accepts, with the notarization ticket stapled [needs: env:SOTY_TEST_EXPECT_NOTARIZED]',
    async () => {
      const { app } = await fixtureBundle();
      await runChain(app);
      await expect(run('spctl', ['--assess', '--type', 'execute', app])).resolves.toBeDefined();
      await expect(run('xcrun', ['stapler', 'validate', app])).resolves.toBeDefined();
    },
    900_000
  );
});
