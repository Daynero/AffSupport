import path from 'node:path';
import { sanitizeFileName } from '../../../apps/agent/src/platform/platform.js';
import { outcome, type AdversarialSuite } from '../adversarial.js';

/**
 * SC-023, C14. One fixed adversarial name set, kept here so every sink that accepts a name
 * — and SC-008's count — points at the same names rather than growing its own half of them.
 * `tests/hostile-filenames.test.ts` drives it through the sanitiser property by property.
 */

/** Each entry is a name and what specifically makes it dangerous. */
export const HOSTILE_NAMES: readonly { name: string; why: string }[] = [
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

/** Why a sanitised name is still unsafe, or null when it is a plain name. */
export function unsafeSanitisedName(name: string): string | null {
  const safe = sanitizeFileName(name);
  if (/[\\/]/u.test(safe)) return 'kept a path separator';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(safe)) return 'kept a control character';
  const workspace = path.join(path.parse(process.cwd()).root, 'tmp', 'workspace');
  const joined = safe === '' ? path.join(workspace, 'kept') : path.join(workspace, safe);
  if (/^(?:\.\.(?:[\\/]|$)|[\\/])/u.test(path.relative(workspace, joined))) {
    return 'resolves outside the directory';
  }
  if (path.normalize(joined) !== joined) return 'is not a normal path segment';
  return null;
}

export const hostileFilenameSuite: AdversarialSuite<object> = {
  testFile: 'tests/hostile-filenames.test.ts',
  start: async () => ({ stop: async () => undefined }),
  attempts: HOSTILE_NAMES.map(({ name, why }) => ({
    name: `a name carrying ${why}`,
    async attempt() {
      const problem = unsafeSanitisedName(name);
      return outcome(problem === null, problem ?? 'neutralised');
    }
  }))
};
