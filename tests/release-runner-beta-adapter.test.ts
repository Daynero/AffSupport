import { expect, it } from 'vitest';
import { betaPackageInput, ownsBetaService } from '../scripts/lib/release/adapters/beta.mjs';

it('requires isolated absolute beta paths and never treats borrowed services as owned', () => {
  expect(
    betaPackageInput({ runtimePath: 'release/Soty.app', outputRoot: '/tmp/beta' })
  ).toMatchObject({ code: 'BETA_INPUT_NOT_ABSOLUTE' });
  expect(ownsBetaService({ pid: 1, ownerRunId: 'other' }, 'run')).toBe(false);
});
