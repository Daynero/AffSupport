import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The five widths (070, FR-040).
 *
 * `scripts/check-design-tokens.mjs` holds every `@media` width to the five in
 * `--breakpoint-*`. It reported until 070 T065; since then a sixth width fails
 * the run with or without `--enforce-media-widths`. These run the checker against a stylesheet of our own in a scratch
 * directory, never the committed ones.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = path.join(root, 'scripts/check-design-tokens.mjs');
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(css: string, ...flags: string[]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'media-widths-'));
  scratch.push(directory);
  writeFileSync(path.join(directory, 'probe.css'), css);
  try {
    const output = execFileSync('node', [CHECKER, `--root=${directory}`, ...flags], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return { ok: true, output };
  } catch (error) {
    const thrown = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${thrown.stdout ?? ''}${thrown.stderr ?? ''}` };
  }
}

describe('media widths', () => {
  it('refuses 561px under the gate and names it', () => {
    const result = run(
      '@media (min-width: 561px) { .probe { display: grid; } }\n',
      '--enforce-media-widths'
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('min-width: 561px');
    expect(result.output).toContain('480px / 640px / 768px / 1024px / 1280px');
  });

  it('refuses 561px without the flag too (the gate is on since T065)', () => {
    const result = run('@media (max-width: 561px) { .probe { display: grid; } }\n');
    expect(result.ok).toBe(false);
    expect(result.output).not.toMatch(/report only/u);
    expect(result.output).toContain('max-width: 561px');
  });

  it('accepts the five, in either syntax', () => {
    const css = [480, 640, 768, 1024, 1280]
      .flatMap(width => [
        `@media (max-width: ${width}px) { .probe { display: grid; } }`,
        `@media (width > ${width}px) { .probe { display: block; } }`
      ])
      .join('\n');
    const result = run(`${css}\n`, '--enforce-media-widths');
    expect(result.output).not.toMatch(/report only/u);
    expect(result.ok).toBe(true);
  });

  it('reads the range syntax and rem as well', () => {
    const result = run(
      '@media (width <= 900px) { .a { display: grid; } }\n@media (max-width: 40rem) { .b { display: grid; } }\n',
      '--enforce-media-widths'
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('width <= 900px');
    expect(result.output).toContain('max-width: 40rem');
  });
});
