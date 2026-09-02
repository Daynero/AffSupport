import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the one property that makes the power limit a *shared*
 * budget rather than a per-tool setting: every heavy child process goes through
 * `power/spawn.ts`, and only the governor suspends one.
 *
 * These are deliberately source-level assertions. The failure they prevent is
 * silent — a new tool that spawns directly simply runs outside the ceiling, and
 * no behavioural test would notice until a user reports that the lever "doesn't
 * always work".
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_SRC = path.join(ROOT, 'apps/agent/src');
const SUPPORT = path.join(ROOT, 'tests/support');

function portableRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * Files allowed to import `node:child_process` for a value import. Anything
 * here spawns either the mechanism itself or a sub-second probe, where managing
 * the process would cost more than it saves.
 */
const SPAWN_ALLOWLIST = [
  'platform/platform.ts',
  'platform/windows-suspend.ts',
  'power/spawn.ts',
  'ffmpeg/tools.ts',
  'whisper/tools.ts',
  'files/picker.ts',
  'files/dropped-source.ts'
];

/** Only the governor may stop or resume a managed child. */
const SUSPEND_ALLOWLIST = ['platform/platform.ts', 'power/governor.ts'];

async function agentSources(): Promise<{ relative: string; source: string }[]> {
  const files: { relative: string; source: string }[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.ts'))
        files.push({
          relative: portableRelative(AGENT_SRC, absolute),
          source: await readFile(absolute, 'utf8')
        });
    }
  };
  await walk(AGENT_SRC);
  return files;
}

describe('managed spawn coverage', () => {
  it('routes every value import of node:child_process through the allowlist', async () => {
    const offenders = (await agentSources())
      .filter(({ relative }) => !SPAWN_ALLOWLIST.includes(relative))
      .filter(({ source }) =>
        // A type-only import carries no ability to spawn; the compressor queue
        // legitimately holds a ChildProcessWithoutNullStreams reference.
        /^import\s+(?!type\s)[^;]*from\s+'node:child_process';/m.test(source)
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it('lets nothing but the governor suspend or resume a managed child', async () => {
    const offenders = (await agentSources())
      .filter(({ relative }) => !SUSPEND_ALLOWLIST.includes(relative))
      .filter(({ source }) => /\b(pauseProcess|resumeProcess)\s*\(/.test(source))
      .map(({ relative }) => relative);

    // Two independent owners of one process's stopped state cannot be made
    // correct by ordering: whichever resumes last wins, and the loser's intent
    // is silently discarded.
    expect(offenders).toEqual([]);
  });

  it('keeps the heavy tools inside the budget', async () => {
    const sources = await agentSources();
    const managed = [
      'ffmpeg/encoder.ts',
      'whisper/transcriber.ts',
      'transcription/media-preview.ts',
      'media-actions/image-converter.ts',
      'landing/workspace.ts',
      'landing/images.ts',
      'translation/translator.ts',
      'translation/aligner.ts',
      'estimate/worker.ts',
      'images/static-edges.ts'
    ];
    for (const relative of managed) {
      const file = sources.find(candidate => candidate.relative === relative);
      expect(file, `${relative} should exist`).toBeDefined();
      expect(file?.source, `${relative} should spawn through the power module`).toMatch(
        /spawnManaged|spawnTracked/
      );
    }
  });

  it('connects the compressor queue to the governor used by its FFmpeg encode', async () => {
    const queue = await readFile(path.join(AGENT_SRC, 'queue/queue.ts'), 'utf8');
    const runMethod = queue.slice(queue.indexOf('  private run('));

    // Going through spawnManaged is insufficient if its governor argument is
    // null. This exact omission made the UI measure only the lightweight agent
    // (~0.1%) while libx264 saturated the machine outside the limit.
    // The governor has to be *an* argument, not the last one: the held-image
    // work (014) appended a child observer after it, and pinning the closing
    // parenthesis made this read as "the governor was dropped".
    expect(runMethod).toMatch(/encodeVideo\([\s\S]*?embedding,\s*this\.power\s*[,)]/);
  });

  it('gives other encoder callers the process-wide governor by default', async () => {
    const encoder = await readFile(path.join(AGENT_SRC, 'ffmpeg/encoder.ts'), 'utf8');
    expect(encoder).toMatch(/governor:\s*ManagedSpawnGovernor \| null = activeGovernorOrNull\(\)/);
  });
});

/**
 * The ban only means anything while everything that spawns is inside its scope.
 *
 * This feature adds three kinds of module that sit **outside** `apps/agent/src` and are
 * therefore outside the rule above: the machine probe, the out-of-process agent harness,
 * and the stub tools. Each of them legitimately starts a process, and each of them could
 * quietly become a second, ungoverned way to run the real encoder — at which point the
 * power assertions would be measuring work no governor owns, and passing.
 *
 * So the scope is stated here rather than assumed: exactly which test-side files may spawn,
 * and what they are allowed to spawn.
 */
describe('the governed seam still bounds everything that spawns', () => {
  /** The only test-side files permitted to start a process, and why. */
  const SUPPORT_SPAWN_ALLOWLIST: Record<string, string> = {
    'machine-probe.ts': 'observes the machine with ps and PowerShell; starts no tool',
    'agent-process.ts': 'boots the agent under test, which owns its own governor',
    'requires.ts': 'asks a binary for its version at collection time'
  };

  async function supportSources(): Promise<{ relative: string; source: string }[]> {
    const files: { relative: string; source: string }[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.name.endsWith('.ts'))
          files.push({
            relative: portableRelative(SUPPORT, absolute),
            source: await readFile(absolute, 'utf8')
          });
      }
    };
    await walk(SUPPORT);
    return files;
  }

  it('lets only the named support modules start a process', async () => {
    const offenders = (await supportSources())
      .filter(({ relative }) => !(relative in SUPPORT_SPAWN_ALLOWLIST))
      .filter(({ source }) => /^import\s+(?!type\s)[^;]*from\s+'node:child_process';/m.test(source))
      .map(({ relative }) => relative);

    // A fixture that spawns is a fixture that can outlive the test that made it. Keeping
    // the list short is what makes "did the stop leave anything running?" answerable.
    expect(offenders).toEqual([]);
  });

  it('never starts a heavy tool from the test side', async () => {
    const offenders: string[] = [];
    for (const { relative, source } of await supportSources()) {
      if (!(relative in SUPPORT_SPAWN_ALLOWLIST)) continue;
      // Reaching the encoder or the transcriber directly would put a real, unmeasured load
      // on the machine outside every budget — and the power tests would still pass, because
      // what they measure is the tree rooted at the agent.
      if (/\b(spawn|execFile|exec)\w*\([^)]*['"`](ffmpeg|ffprobe|whisper)/.test(source))
        offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('makes the stub tools reachable only by redirecting the agent’s own tool paths', async () => {
    const factory = await readFile(path.join(SUPPORT, 'stub-tools/index.ts'), 'utf8');

    // The factory writes a file and returns its path; the agent runs it through
    // `power/spawn.ts` exactly as it runs the real encoder. If the factory launched the
    // stub itself, the stub would run outside the budget and every throttling assertion
    // built on it would be measuring nothing.
    expect(factory).not.toMatch(/from 'node:child_process'/);
    expect(factory).toContain('writeStubTool');
  });

  it('keeps the machine probe out of the spawn seam it is checking', async () => {
    const probe = await readFile(path.join(SUPPORT, 'machine-probe.ts'), 'utf8');

    // Doubled from tests/machine-probe-independence.test.ts on purpose: that file guards
    // independence, this one guards the spawn budget, and the same import would break both.
    // Matched against import specifiers rather than the whole file — the module's own
    // comments name those directories precisely because it must not import from them.
    const imported = [...probe.matchAll(/from\s+'([^']+)'/g)].map(match => match[1] as string);
    expect(
      imported.filter(specifier => /apps\/agent\/src\/(power|platform)\//.test(specifier))
    ).toEqual([]);
    expect(probe).toMatch(/'\/bin\/ps'/);
  });
});
