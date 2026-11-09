import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { betaPackageProvenance } from '../scripts/beta-package-provenance.mjs';
import { assertMacosBetaEvidence } from '../scripts/lib/release/platform-evidence.mjs';

describeRequiring(requirePlatform('darwin'), 'Intel static qualification', () => {
  it('records the real signed target inspection without executing Intel code or requiring hardware reports', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'intel-static-qualification-'));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.hooksPath', path.join(cwd, '.no-hooks'));
      await writeFile(path.join(cwd, '.gitignore'), 'release/\n.env.beta\n');
      git('add', '.gitignore');
      git('commit', '-qm', 'fixture');
      const sourceSha = git('rev-parse', 'HEAD');
      await writeFile(
        path.join(cwd, '.env.beta'),
        'VITE_SUPABASE_URL=http://127.0.0.1:54321\nAGENT_ENTITLEMENT_PUBLIC_KEY=fixture-public\n'
      );
      const root = path.join(cwd, 'release/beta/x64');
      const app = path.join(root, 'Soty Beta.app');
      const marker = path.join(cwd, 'release/intel-runtime-executed');
      await mkdir(root, { recursive: true });
      const source = path.join(root, 'fixture.c');
      const binary = path.join(root, 'fixture');
      await writeFile(
        source,
        `#include <stdio.h>\nint main(void){FILE*f=fopen(${JSON.stringify(marker)},"w");if(f){fputs("executed",f);fclose(f);}return 0;}\n`
      );
      const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
        encoding: 'utf8'
      }).trim();
      execFileSync(
        'xcrun',
        ['clang', '-target', 'x86_64-apple-macos13.0', '-isysroot', sdk, source, '-o', binary],
        { timeout: 30000, stdio: 'pipe' }
      );
      const finder = 'Contents/PlugIns/SotyFinderExtension.appex';
      for (const relative of [
        'Contents/MacOS/SotyBetaAgent',
        `${finder}/Contents/MacOS/SotyFinderExtension`,
        'Contents/Resources/runtime/node',
        ...['ffmpeg', 'ffprobe', 'whisper-cli'].map(
          name => `Contents/Resources/runtime/bin/${name}`
        )
      ]) {
        const target = path.join(app, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(binary, target);
      }
      for (const [directory, executable, identifier, kind] of [
        [app, 'SotyBetaAgent', 'com.wishly.beta', 'APPL'],
        [path.join(app, finder), 'SotyFinderExtension', 'com.wishly.beta.finder-extension', 'XPC!']
      ] as const) {
        await writeFile(
          path.join(directory, 'Contents/Info.plist'),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundlePackageType</key><string>${kind}</string><key>CFBundleVersion</key><string>79</string></dict></plist>`
        );
      }
      const resources = path.join(app, 'Contents/Resources');
      await mkdir(path.join(resources, 'web/dist'), { recursive: true });
      await writeFile(path.join(resources, 'web/dist/index.html'), 'fixture');
      await writeFile(
        path.join(resources, 'release.json'),
        JSON.stringify({
          channel: 'beta',
          architecture: 'x64',
          target: 'macos-x64',
          sourceRevision: sourceSha,
          buildId: '1.3.3+79'
        })
      );
      // 048 T008: the fixture is signed the way the beta packager signs — through the
      // chain, ad-hoc — and the chain's summary sits beside it for the proof to audit.
      const summary = execFileSync('zsh', [path.resolve('scripts/sign-mac-app.sh'), app], {
        env: { ...env, SOTY_SIGNING_IDENTITY: '-', SOTY_SKIP_NOTARIZATION: '1' },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 60000
      });
      await writeFile(path.join(root, 'signing.json'), summary);
      await betaPackageProvenance({ cwd, action: 'record', arch: 'x64' });
      execFileSync(
        process.execPath,
        [path.resolve('scripts/record-macos-beta-proof.mjs'), '--arch=x64'],
        { cwd, env, timeout: 30000, stdio: 'pipe' }
      );
      const proof = await assertMacosBetaEvidence(cwd, 'macos-x64', { sourceSha });
      expect(proof).toMatchObject({
        schemaVersion: 3,
        verificationMode: 'static-cross-build',
        acceptancePolicy: 'intel-user-feedback-v1',
        runtimeStatus: 'unverified',
        hardwareStatus: 'unverified',
        nativeFileCount: 6,
        // Launcher, Finder extension, node and three engines: all hardened; the chain's
        // own count leaves the extension's binary to its nested bundle.
        codeSigning: { identity: 'adhoc', hardenedMachO: 6, machO: 5, profiles: { node: 1 } }
      });
      expect(proof).not.toHaveProperty('runtimeArchitecture');
      await expect(access(marker)).rejects.toThrow();
      await expect(access(path.join(root, 'hardware-acceptance.json'))).rejects.toThrow();
      const record = JSON.parse(await readFile(path.join(root, 'verification.json'), 'utf8'));
      expect(record.signatureIntegrity).toBe('verified');
      await writeFile(path.join(resources, 'web/dist/index.html'), 'tampered');
      await expect(assertMacosBetaEvidence(cwd, 'macos-x64', { sourceSha })).rejects.toThrow(
        'PROVENANCE_MISMATCH'
      );
    } finally {
      await removeTemporaryDirectory(cwd);
    }
  }, 60000);
});
