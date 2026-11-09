import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { betaCatalogVideoFlag } from '../scripts/lib/beta-catalog-video-flags.mjs';
const env = (web: string, native: string) =>
  `VITE_CATALOG_VIDEO_VARIANTS=${web}\nSOTY_CATALOG_VIDEO_VARIANTS=${native}\n`;
it('requires strict matching file opt-ins and defaults both surfaces off', () => {
  expect(betaCatalogVideoFlag('OTHER_SECRET=synthetic-canary\n')).toBe('false');
  expect(betaCatalogVideoFlag(env('true', 'true'))).toBe('true');
  expect(betaCatalogVideoFlag(env('false', 'false'))).toBe('false');
  expect(betaCatalogVideoFlag(' VITE_CATALOG_VIDEO_VARIANTS = false\n')).toBe('false');
  for (const value of ['1', 'TRUE', 'yes', '"true"', 'true # comment', '']) {
    expect(() => betaCatalogVideoFlag(env(value, value))).toThrow('true or false');
  }
  expect(() => betaCatalogVideoFlag(env('true', 'false'))).toThrow('must agree');
  expect(() => betaCatalogVideoFlag('VITE_CATALOG_VIDEO_VARIANTS=true')).toThrow('must agree');
  expect(() => betaCatalogVideoFlag('VITE_CATALOG_VIDEO_VARIANTS')).toThrow('true or false');
  expect(() =>
    betaCatalogVideoFlag(env('true', 'true') + 'VITE_CATALOG_VIDEO_VARIANTS=false')
  ).toThrow('Duplicate');
});
it('reads only the selected beta file and never reports secret contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'soty-beta-flags-'));
  try {
    const file = join(directory, 'synthetic.env');
    writeFileSync(file, env('false', 'false') + 'PRIVATE=synthetic-secret-canary\n');
    const stdout = execFileSync(process.execPath, ['scripts/beta-catalog-video-flag.mjs', file], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VITE_CATALOG_VIDEO_VARIANTS: 'true',
        SOTY_CATALOG_VIDEO_VARIANTS: 'true'
      }
    });
    expect(stdout).toBe('false');
    writeFileSync(file, env('synthetic-secret-canary', 'false'));
    try {
      execFileSync(process.execPath, ['scripts/beta-catalog-video-flag.mjs', file], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      throw Error('Expected rejection');
    } catch (error) {
      const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer };
      expect(String(failure.stderr)).toContain('matching true/false');
      expect(String(failure.stderr)).not.toContain('synthetic-secret-canary');
      expect(String(failure.stdout)).not.toContain('synthetic-secret-canary');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('propagates one resolved flag into beta web and signed plist while keeping auth real', () => {
  const script = readFileSync('scripts/package-beta-mac.sh', 'utf8');
  expect(script).toContain(
    'beta_catalog_video_variants=$(node scripts/beta-catalog-video-flag.mjs .env.beta)'
  );
  expect(script).toContain('VITE_CATALOG_VIDEO_VARIANTS="$beta_catalog_video_variants"');
  expect(script).toContain('Add :SotyBetaCatalogVideoVariants bool $beta_catalog_video_variants');
  expect(script).toContain('Print :SotyBetaCatalogVideoVariants');
  expect(script).toContain('VITE_LOCAL_DEV_AUTH=false');
  expect(readFileSync('packaging/Info.plist', 'utf8')).not.toContain(
    'SotyBetaCatalogVideoVariants'
  );
  for (const path of ['scripts/package-mac.sh', 'scripts/package-dev-mac.sh'])
    expect(readFileSync(path, 'utf8')).not.toContain('SotyBetaCatalogVideoVariants');
  const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
  expect(launcher).toContain('"SOTY_CATALOG_VIDEO_VARIANTS": betaCatalogVideoEnabled(');
  expect(launcher).toContain(
    'infoValue: Bundle.main.object(forInfoDictionaryKey: "SotyBetaCatalogVideoVariants")'
  );
  expect(launcher).toContain('ProcessInfo.processInfo.environment.merging(packagedEnvironment)');
});
it.runIf(process.platform === 'darwin')(
  'executes the actual Swift sealed-boolean/channel guard',
  () => {
    const source = readFileSync('packaging/Launcher.swift', 'utf8');
    const helper = source
      .split('// BEGIN beta catalog video flag')[1]!
      .split('// END beta catalog video flag')[0]!;
    const directory = mkdtempSync(join(tmpdir(), 'soty-beta-swift-'));
    try {
      const file = join(directory, 'Flags.swift'),
        binary = join(directory, 'flags');
      writeFileSync(
        file,
        `import Foundation\nimport CoreFoundation\n${helper}\nlet results = [\n betaCatalogVideoEnabled(releaseChannel: "beta", infoValue: true),\n betaCatalogVideoEnabled(releaseChannel: "beta", infoValue: false),\n betaCatalogVideoEnabled(releaseChannel: "beta", infoValue: NSNumber(value: 1)),\n betaCatalogVideoEnabled(releaseChannel: "beta", infoValue: "true"),\n betaCatalogVideoEnabled(releaseChannel: "stable", infoValue: true),\n betaCatalogVideoEnabled(releaseChannel: "development", infoValue: true),\n betaCatalogVideoEnabled(releaseChannel: "beta", infoValue: nil)\n]\nprint(results.map { $0 ? "true" : "false" }.joined(separator: ","))\n`
      );
      execFileSync(
        'swiftc',
        [file, '-module-cache-path', join(directory, 'module-cache'), '-o', binary],
        { timeout: 60000, stdio: 'pipe' }
      );
      expect(execFileSync(binary, [], { encoding: 'utf8', timeout: 5000 }).trim()).toBe(
        'true,false,false,false,false,false,false'
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  90000
);
