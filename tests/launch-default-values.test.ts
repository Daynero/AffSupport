import { expect, it } from 'vitest';
import {
  launchDefaultValues,
  applyLaunchDefaultValues
} from '../packages/shared/src/team/launches/defaults';

it('saves reusable launch settings while excluding the selected creative and launch date', () => {
  const draft = {
    buyerId: 'buyer',
    adsCount: 3,
    age: 25,
    materialId: 'private-creative',
    launchDate: '2026-10-24',
    catalog: undefined
  };
  expect(launchDefaultValues(draft)).toEqual({ buyerId: 'buyer', adsCount: 3, age: 25 });
  expect(draft.materialId).toBe('private-creative');
});
it('replaces optional defaults completely while retaining the current creative and launch date', () => {
  const catalog = {
    productCount: 3,
    restitchEnabled: true,
    finalDurationMode: 'random-30-40' as const,
    customFinalDurationSeconds: null
  };
  const current = {
    buyerId: 'old-buyer',
    adsCount: 5,
    catalog,
    age: 18,
    materialId: 'current-creative',
    launchDate: '2026-10-24'
  };
  const profile = {
    buyerId: 'new-buyer',
    adsCount: 2,
    materialId: 'stored-creative',
    launchDate: '2026-01-01'
  };
  expect(applyLaunchDefaultValues(current, profile)).toEqual({
    buyerId: 'new-buyer',
    adsCount: 2,
    materialId: 'current-creative',
    launchDate: '2026-10-24'
  });
  expect(current.catalog).toBe(catalog);
  expect(profile.materialId).toBe('stored-creative');
});
it('applying an empty profile clears stale reusable fields without clearing the current creative', () => {
  expect(applyLaunchDefaultValues({ age: 18, buyerId: 'old', materialId: 'current' }, {})).toEqual({
    materialId: 'current'
  });
});
