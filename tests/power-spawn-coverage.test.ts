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

const AGENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/agent/src');

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
          relative: path.relative(AGENT_SRC, absolute),
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
    expect(runMethod).toMatch(/encodeVideo\([\s\S]*?embedding,\s*this\.power\s*\)/);
  });

  it('gives other encoder callers the process-wide governor by default', async () => {
    const encoder = await readFile(path.join(AGENT_SRC, 'ffmpeg/encoder.ts'), 'utf8');
    expect(encoder).toMatch(/governor:\s*ManagedSpawnGovernor \| null = activeGovernorOrNull\(\)/);
  });
});
