import { describe, expect, it } from 'vitest';
import { releaseNotesForVersion } from '../scripts/lib/release/notes.mjs';

describe('published release notes', () => {
  it('publishes only the selected version, without historical implementation details', () => {
    expect(
      releaseNotesForVersion(
        '# v1.2.7\r\n\r\n- Виправлено помилки.\r\n\r\n# v1.2.6\r\n\r\nOld detailed changes.\r\n',
        '1.2.7'
      )
    ).toBe('- Виправлено помилки.\n');
  });
  it('refuses missing, duplicate or empty sections before publication', () => {
    for (const notes of ['# v1.2.6\nold', '# v1.2.7\n', '# v1.2.7', '# v1.2.7\none\n# v1.2.7\ntwo'])
      expect(() => releaseNotesForVersion(notes, '1.2.7')).toThrow('RELEASE_NOTES_INVALID');
  });
});
