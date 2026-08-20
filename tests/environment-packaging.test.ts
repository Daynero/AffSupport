import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BETA_PROFILE,
  DEV_PROFILE,
  ENVIRONMENT_PROFILES,
  PRODUCTION_PROFILE
} from '../packages/shared/src/environment.js';

/**
 * The environment profiles are only a source of truth if something reads them.
 *
 * They were introduced as one, and were not: every packaging entry point spelled
 * the port, app name, bundle id, support directory, and lock file out again, and
 * the production profile had already drifted from the artifact it claimed to
 * describe — a lock name and a bundle id that no shipped copy of Soty has ever
 * used. Nothing failed, because nothing compared them.
 *
 * This is the comparison. A packaging script that starts restating an identity
 * fails here rather than at the point where two builds discover they are
 * fighting over one lock file.
 */

const PACKAGING_SOURCES = {
  'scripts/package-mac.sh': 'production',
  'scripts/package-dev-mac.sh': 'dev',
  'scripts/package-beta-mac.sh': 'beta',
  '.github/workflows/release-windows.yml': 'production'
} as const;

const sources = Object.entries(PACKAGING_SOURCES).map(([file, profile]) => ({
  file,
  profile,
  text: readFileSync(file, 'utf8')
}));

/**
 * Everything that must not restate an identity, whether or not it goes through
 * `environment-meta.mjs`. The Windows smoke harness imports the profile
 * directly — it is Node, not shell — but it is proving an installer whose port
 * comes from the same place, so a second spelling would let the two drift and
 * the gate would silently test a port nothing listens on.
 */
const identityConsumers = [
  ...sources,
  { file: 'scripts/windows-smoke.mjs', text: readFileSync('scripts/windows-smoke.mjs', 'utf8') }
];

/**
 * Slots distinctive enough that finding one spelled out is unambiguous
 * evidence of a second source. `appName` and `supportDirectoryName` are left
 * out on purpose: "Soty" appears legitimately in output paths and executable
 * names all over these scripts.
 */
const IDENTITY_SLOTS = ['bundleId', 'instanceLockName', 'agentPort'] as const;

describe('environment profiles as the single source of truth', () => {
  it('describes the identities the shipped artifacts actually carry', () => {
    // Read straight off the production bundle's own plist and the launcher
    // contract, not off the profile — otherwise this only proves the profile
    // agrees with itself.
    const plist = readFileSync('packaging/Info.plist', 'utf8');
    expect(plist).toContain(`<string>${PRODUCTION_PROFILE.bundleId}</string>`);
    const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
    expect(launcher).toContain(PRODUCTION_PROFILE.instanceLockName.replace(/\.lock$/u, ''));
  });

  it('keeps every slot distinct so the three builds can run side by side', () => {
    for (const slot of [...IDENTITY_SLOTS, 'supportDirectoryName', 'appName'] as const) {
      const values = ENVIRONMENT_PROFILES.map(profile => String(profile[slot]));
      expect(new Set(values).size).toBe(ENVIRONMENT_PROFILES.length);
    }
  });

  it('is read by every packaging entry point rather than retyped', () => {
    for (const { file, profile, text } of sources) {
      expect(text, `${file} does not read the ${profile} profile`).toContain(
        `environment-meta.mjs ${profile}`
      );
    }
  });

  it('has no packaging script spelling an identity out a second time', () => {
    const profiles = { production: PRODUCTION_PROFILE, dev: DEV_PROFILE, beta: BETA_PROFILE };
    for (const { file, text } of identityConsumers) {
      for (const profile of Object.values(profiles)) {
        for (const slot of IDENTITY_SLOTS) {
          const literal = String(profile[slot]);
          expect(text.includes(literal), `${file} hardcodes ${slot} (${literal})`).toBe(false);
        }
      }
    }
  });

  it('resolves every slot the packaging scripts ask for', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    for (const { file, profile, text } of sources) {
      const fields = [...text.matchAll(/environment-meta\.mjs (\w+) ([a-z-]+)/gu)];
      expect(fields.length, `${file} reads no profile fields`).toBeGreaterThan(0);
      for (const [, named, field] of fields) {
        expect(named, `${file} reads the ${named} profile`).toBe(profile);
        const { stdout } = await run('node', ['scripts/environment-meta.mjs', named, field]);
        expect(stdout.trim(), `${named} ${field} resolved to nothing`).not.toBe('');
      }
    }
  }, 30_000);
});
