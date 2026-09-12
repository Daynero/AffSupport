import { expect, it } from 'vitest';
import { packageAction } from '../scripts/lib/release/adapters/package.mjs';

it('never rebuilds published assets', () => {
  expect(
    packageAction({ published: true, input: { runtimePath: '/x', outputPath: '/y' } })
  ).toMatchObject({ code: 'PUBLISHED_REBUILD_FORBIDDEN' });
});
