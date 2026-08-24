import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe } from 'vitest';

const run = promisify(execFile);

/**
 * Skips that say why, and that a machine can count.
 *
 * Fourteen sites across five files did `if (!available) return;` inside a test body. That
 * reports as **passed**, not skipped — so a runner without FFmpeg produced a green tick
 * for tests that checked nothing. The constitution has named this an anti-pattern since
 * ratification and it survived anyway, because nothing enforced it.
 *
 * Two design points, both load-bearing:
 *
 * 1. **The probe runs at collection time**, via top-level await in the importing module.
 *    At every one of those fourteen sites the availability flag was assigned inside a
 *    `beforeAll`, so a collection-time `skipIf` would have read `false` and skipped
 *    everything. The probe has to have already run before the suite is declared.
 *
 * 2. **The reason is encoded in the suite title** as `[needs: ffmpeg,ffprobe]`. That makes
 *    it visible in the runner's JSON report with no ledger file, no global state and no
 *    reporter plugin — so the verification command can histogram skip reasons, and can
 *    fail on any skipped test whose name carries no marker. An unexplained skip becomes a
 *    failure rather than a silent gap.
 *
 * Set `SOTY_REQUIRE_ALL=1` (the release form does) to make a missing requirement **throw**
 * instead of skip, naming what is absent. Otherwise a release runner that quietly lost its
 * toolchain reports zero skips because nothing ran, which looks identical to success.
 */

export interface Requirement {
  /** What is missing, for the title marker and the failure message. */
  readonly names: readonly string[];
  /** True when at least one named dependency could not be found. */
  readonly missing: boolean;
}

const requireAll = process.env.SOTY_REQUIRE_ALL === '1';

function enforce(requirement: Requirement): Requirement {
  if (requirement.missing && requireAll) {
    throw new Error(
      `SOTY_REQUIRE_ALL is set but a required dependency is absent: ${requirement.names.join(', ')}. ` +
        'On the release runner every dependency must be present; a skip here would report ' +
        'as zero skipped tests and be indistinguishable from a clean run.'
    );
  }
  return requirement;
}

/** True when every named executable answers `--version` (or `-version`). */
export async function requireBinaries(...names: string[]): Promise<Requirement> {
  const checks = await Promise.all(
    names.map(async name => {
      for (const flag of ['--version', '-version']) {
        try {
          await run(name, [flag]);
          return true;
        } catch {
          // Try the other flag before concluding the binary is absent — FFmpeg answers
          // `-version`, most other tools answer `--version`.
        }
      }
      return false;
    })
  );
  return enforce({ names, missing: checks.some(found => !found) });
}

/** True when every named path exists. Use for build outputs and downloaded models. */
export function requirePath(...paths: string[]): Requirement {
  return enforce({ names: paths, missing: paths.some(candidate => !existsSync(candidate)) });
}

/** True when the current platform is one of those named. */
export function requirePlatform(...platforms: NodeJS.Platform[]): Requirement {
  return enforce({
    names: platforms.map(platform => `platform:${platform}`),
    missing: !platforms.includes(process.platform)
  });
}

/** Combines requirements so one suite can state everything it needs. */
export function allOf(...requirements: Requirement[]): Requirement {
  return {
    names: requirements.flatMap(requirement => requirement.names),
    missing: requirements.some(requirement => requirement.missing)
  };
}

/**
 * Declares a suite that skips — visibly, with a reason — when its requirement is absent.
 *
 * The `[needs: ...]` marker is not decoration. The verification command reads it back out
 * of the runner's report; a skipped test without one fails the run.
 */
export function describeRequiring(requirement: Requirement, title: string, body: () => void): void {
  const marked = `${title} [needs: ${requirement.names.join(',')}]`;
  if (requirement.missing) {
    describe.skip(marked, body);
    return;
  }
  describe(marked, body);
}
