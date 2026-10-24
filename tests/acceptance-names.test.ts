import { expect, it } from 'vitest';
import { fixtureAccountName } from '../scripts/acceptance/names.mjs';
it('keeps even the longest accepted namespace inside the product account-name limit', () => {
  const namespace = `acceptance-${'a'.repeat(64)}`;
  for (const variant of ['A', 'stale', 'paused-A', 'renewed-C']) {
    const name = fixtureAccountName(namespace, '1234abcd', variant);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toMatch(/^036-[a-f0-9]{8}-1234abcd-/);
  }
});
it('is stable within a fixture and distinguishes namespace/run/actor', () => {
  const input = ['acceptance-test-001', '1234abcd', 'A'] as const;
  expect(fixtureAccountName(...input)).toBe(fixtureAccountName(...input));
  expect(fixtureAccountName(...input)).not.toBe(
    fixtureAccountName('acceptance-test-002', '1234abcd', 'A')
  );
  expect(fixtureAccountName(...input)).not.toBe(fixtureAccountName(input[0], '5678abcd', 'A'));
  expect(fixtureAccountName(...input)).not.toBe(fixtureAccountName(input[0], input[1], 'B'));
});
it('refuses unbounded or malformed inputs', () => {
  expect(() => fixtureAccountName('../foreign', '1234abcd', 'A')).toThrow(
    'ACCEPTANCE_FIXTURE_NAME_INVALID'
  );
  expect(() => fixtureAccountName('acceptance-test-001', '1234abcd', 'a'.repeat(41))).toThrow(
    'ACCEPTANCE_FIXTURE_NAME_INVALID'
  );
});
