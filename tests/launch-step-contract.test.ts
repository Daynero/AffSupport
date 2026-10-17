import { expect, it } from 'vitest';
import {
  parseLaunchGeneration,
  parseLaunchGenerationStep
} from '../packages/shared/src/team/launches';
it('parses closed step states and marks an unknown stage or cause without copying its text', () => {
  const input = {
    id: 'step',
    stage: 'catalog_creating',
    state: 'running',
    attemptNo: 1,
    errorCode: null
  };
  expect(parseLaunchGenerationStep(input)).toEqual(input);
  expect(
    parseLaunchGenerationStep({
      ...input,
      stage: 'SYNTHETIC_PRIVATE_STAGE',
      errorCode: 'SYNTHETIC_PRIVATE_CAUSE'
    })
  ).toMatchObject({ stage: 'unknown', errorCode: 'UNKNOWN' });
  expect(parseLaunchGenerationStep({ ...input, state: 'made_up' })).toBeNull();
  expect(parseLaunchGenerationStep({ ...input, attemptNo: 1.5 })).toBeNull();
});
it('accepts older producers without step history but bounds and validates supplied receipts', () => {
  const generation = {
    id: 'generation',
    state: 'running',
    stage: 'catalog_creating',
    stateVersion: '1',
    progress: null,
    errorCode: null,
    childOperationIds: []
  };
  expect(parseLaunchGeneration(generation)).not.toBeNull();
  const step = {
    id: 'step',
    stage: 'catalog_creating',
    state: 'running',
    attemptNo: 1,
    errorCode: null
  };
  expect(
    parseLaunchGeneration({ ...generation, steps: [step], stepsTruncated: false })
  ).toMatchObject({ steps: [step], stepsTruncated: false });
  expect(parseLaunchGeneration({ ...generation, steps: Array(51).fill(step) })).toBeNull();
  expect(parseLaunchGeneration({ ...generation, stepsTruncated: 'false' })).toBeNull();
});

it('keeps bigint versions as canonical strings without unsafe numeric coercion', async () => {
  const { isLaunchVersion } = await import('../packages/shared/src/team/launches');
  expect(isLaunchVersion('9223372036854775807')).toBe(true);
  for (const invalid of ['9223372036854775808', '01', '0', '-1', '1.0', 1])
    expect(isLaunchVersion(invalid)).toBe(false);
});
