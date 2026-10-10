import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../apps/agent/src/platform/platform.js';
import { runAttempt } from './support/adversarial.js';
import { HOSTILE_NAMES, hostileFilenameSuite } from './support/adversarial/hostile-filenames.js';

/**
 * One fixed adversarial name set, driven through everything that accepts a
 * name from outside.
 *
 * Filenames are the most reliably hostile input this application takes, because
 * they arrive from a drop, an upload, a Drive listing or a picker, and every one
 * of those paths eventually joins them onto a directory the user did not choose.
 * The set is kept in one place — `tests/support/adversarial/hostile-filenames.ts` — so a
 * new sink can be pointed at the same names rather than growing its own half of them, and
 * so SC-008's count (`tests/adversarial-suite-size.test.ts`) counts exactly these.
 */

describe('the sanitiser', () => {
  it.each(HOSTILE_NAMES)('never returns a path separator for $why', ({ name }) => {
    const safe = sanitizeFileName(name);
    // The one property everything downstream depends on: whatever comes back is
    // a name, not a path. A separator here is a directory escape at every call
    // site at once.
    expect(safe).not.toMatch(/[\\/]/u);
  });

  it.each(HOSTILE_NAMES)('never returns something that resolves upwards for $why', ({ name }) => {
    const safe = sanitizeFileName(name);
    // An empty result is a pass, not a skip: the sanitiser is allowed to decide
    // that nothing usable remains, and that is the safest answer of all.
    const workspace = path.join(path.parse(process.cwd()).root, 'tmp', 'workspace');
    const joined = safe === '' ? path.join(workspace, 'kept') : path.join(workspace, safe);
    const relative = path.relative(workspace, joined);
    expect(relative).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[\\/])/u);
    expect(path.normalize(joined)).toBe(joined);
  });

  it.each(HOSTILE_NAMES)('never returns a control character for $why', ({ name }) => {
    // eslint-disable-next-line no-control-regex
    expect(sanitizeFileName(name)).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it('refuses the bare directory names outright', () => {
    // '.' and '..' survive character filtering — they contain nothing illegal —
    // and are still not usable as names.
    expect(['', '_.', '_..']).toContain(sanitizeFileName('.') || '');
    expect(sanitizeFileName('..')).not.toBe('..');
  });

  it('prefixes a Windows device name, with or without an extension', () => {
    expect(sanitizeFileName('CON')).not.toBe('CON');
    expect(sanitizeFileName('con.txt')).not.toBe('con.txt');
  });

  it('keeps an ordinary name exactly as it is', () => {
    // The other half of the contract: a sanitiser that mangles safe input is a
    // sanitiser people work around.
    expect(sanitizeFileName('Літній відпочинок 2026.mov')).toBe('Літній відпочинок 2026.mov');
    expect(sanitizeFileName('report (final) v2.pdf')).toBe('report (final) v2.pdf');
  });
});

describe('the shared adversarial table', () => {
  it.each(hostileFilenameSuite.attempts.map(attempt => [attempt.name, attempt] as const))(
    '%s is neutralised',
    async (_name, attempt) => {
      const result = await runAttempt(hostileFilenameSuite, attempt);
      expect(result.refused, result.evidence).toBe(true);
    }
  );
});
