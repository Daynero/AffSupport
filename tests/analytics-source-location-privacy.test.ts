import { expect, it } from 'vitest';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
it('allows only bounded analytics source locations in the source-file field', () => {
  expect(
    investigateOutputIsPrivate({
      code_locations: [{ files: ['scripts/analytics/material-groups.ts'] }]
    })
  ).toBe(true);
  for (const file of [
    'scripts/analytics/../../private.env',
    '/Users/private/file.ts',
    'scripts/private.env',
    'https://private.invalid/file',
    'scripts/analytics/secret?token=value'
  ]) {
    expect(investigateOutputIsPrivate({ code_locations: [{ files: [file] }] })).toBe(false);
  }
  expect(investigateOutputIsPrivate({ note: 'scripts/analytics/material-groups.ts' })).toBe(false);
});
