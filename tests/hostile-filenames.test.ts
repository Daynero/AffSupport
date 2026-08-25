import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../apps/agent/src/platform/platform.js';

/**
 * One fixed adversarial name set, driven through everything that accepts a
 * name from outside.
 *
 * Filenames are the most reliably hostile input this application takes, because
 * they arrive from a drop, an upload, a Drive listing or a picker, and every one
 * of those paths eventually joins them onto a directory the user did not choose.
 * The set is kept in one place so a new sink can be pointed at the same names
 * rather than growing its own half of them.
 */

/** Each entry is a name and what specifically makes it dangerous. */
const HOSTILE_NAMES: readonly { name: string; why: string }[] = [
  { name: '../../etc/passwd', why: 'traversal through a parent directory' },
  { name: '..\\..\\windows\\system32', why: 'traversal with Windows separators' },
  { name: '/etc/shadow', why: 'an absolute POSIX path' },
  { name: 'C:\\Windows\\System32\\drivers', why: 'an absolute Windows path' },
  { name: 'video".mov', why: 'a quotation mark, which used to close a query literal' },
  { name: "video'.mov", why: 'a single quote' },
  { name: 'video`whoami`.mov', why: 'shell command substitution' },
  { name: 'video$(whoami).mov', why: 'shell command substitution, POSIX form' },
  { name: 'video;rm -rf ~.mov', why: 'a command separator' },
  { name: 'video|tee.mov', why: 'a pipe' },
  { name: 'video\u0000.mov', why: 'a NUL byte, which truncates a C string' },
  { name: 'video\n.mov', why: 'a newline, which splits a line-oriented protocol' },
  { name: 'video\r\n.mov', why: 'a CRLF, which splits a header' },
  { name: 'CON', why: 'a Windows reserved device name' },
  { name: 'con.txt', why: 'a reserved device name with an extension' },
  { name: 'video .', why: 'a trailing dot and space, which Windows silently strips' },
  { name: '.', why: 'the current directory' },
  { name: '..', why: 'the parent directory' },
  { name: '\u202Egnp.exe', why: 'a right-to-left override, which disguises an extension' },
  { name: 'a'.repeat(500), why: 'a name longer than most filesystems accept' }
];

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
    const joined = safe === '' ? '/tmp/workspace/kept' : path.join('/tmp/workspace', safe);
    expect(joined.startsWith('/tmp/workspace/')).toBe(true);
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
