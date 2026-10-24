import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  provisionLocalVariants,
  validateVariantState,
  variantMembersMatch,
  variantTariffMatches
} from '../scripts/acceptance/variants.mjs';

const namespace = 'acceptance-variants-test';
function state() {
  return {
    schemaVersion: 1,
    namespace,
    actors: Object.fromEntries(
      ['SOLO', 'PENDING'].map(alias => [
        alias,
        {
          id: randomUUID(),
          email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
          password: 'a'.repeat(32),
          provisioned: false
        }
      ])
    ),
    teams: {},
    tariffs: {}
  };
}
it('refuses unsafe variant targets before any file, database or Auth access', async () => {
  await expect(provisionLocalVariants({ kind: 'production' })).rejects.toThrow(
    'ACCEPTANCE_TARGET_UNSAFE'
  );
});
it('owns two distinct synthetic actors and only the named variant references', () => {
  const input = state();
  expect(validateVariantState(input, namespace).ok).toBe(true);
  expect(
    validateVariantState(
      {
        ...input,
        teams: { WSolo: randomUUID(), WLegacy: randomUUID() },
        tariffs: { Solo: randomUUID(), PendingSolo: randomUUID() }
      },
      namespace
    ).ok
  ).toBe(true);
  expect(validateVariantState({ ...input, teams: { WForeign: randomUUID() } }, namespace).ok).toBe(
    false
  );
  expect(
    validateVariantState({ ...input, tariffs: { PendingSolo: 'not-a-uuid' } }, namespace).ok
  ).toBe(false);
  expect(
    validateVariantState(
      {
        ...input,
        actors: { ...input.actors, PENDING: { ...input.actors.PENDING, id: input.actors.SOLO.id } }
      },
      namespace
    ).ok
  ).toBe(false);
  input.actors.PENDING.email = 'real@example.com';
  expect(validateVariantState(input, namespace).ok).toBe(false);
});
it('rejects unknown state fields and foreign campaign metadata', () => {
  expect(validateVariantState({ ...state(), secret: 'unexpected' }, namespace).ok).toBe(false);
  expect(validateVariantState(state(), 'acceptance-other-campaign').ok).toBe(false);
  expect(validateVariantState({ ...state(), actors: [] }, namespace).ok).toBe(false);
});
it('refuses foreign members, removed roles and overrides in an adopted legacy fixture', () => {
  const expected = [
    { userId: 'owner', role: 'admin' },
    { userId: 'global-admin', role: 'viewer' }
  ];
  const rows = expected.map(m => ({
    user_id: m.userId,
    base_role: m.role,
    status: 'active',
    permission_overrides: {}
  }));
  expect(variantMembersMatch(rows, expected)).toBe(true);
  expect(variantMembersMatch([...rows, { ...rows[1], user_id: 'foreign' }], expected)).toBe(false);
  expect(variantMembersMatch([rows[0], { ...rows[1], status: 'removed' }], expected)).toBe(false);
  expect(
    variantMembersMatch([rows[0], { ...rows[1], permission_overrides: { edit: true } }], expected)
  ).toBe(false);
});
it('requires exact tariff marker, dates, seats and intended binding before adoption', () => {
  const owner = { id: randomUUID(), email: `${namespace}-pending@soty.invalid` };
  const options = {
    namespace,
    owner,
    adminId: randomUUID(),
    binding: null,
    now: Date.parse('2026-10-20T23:00:00Z')
  };
  const row = {
    id: randomUUID(),
    owner_id: owner.id,
    owner_email: owner.email,
    note: namespace,
    granted_by: options.adminId,
    team_id: null,
    plan_code: 'solo',
    extra_seats: 0,
    revoked_at: null,
    source: 'manual',
    external_ref: null,
    starts_at: '2026-10-20T22:00:00Z',
    ends_on: '2026-11-19'
  };
  expect(variantTariffMatches(row, options)).toBe(true);
  for (const patch of [
    { note: 'foreign' },
    { extra_seats: 1 },
    { granted_by: randomUUID() },
    { team_id: randomUUID() },
    { ends_on: '2026-10-20' },
    { ends_on: '2027-11-19' },
    { starts_at: '2027-10-20T23:00:00Z' }
  ])
    expect(variantTariffMatches({ ...row, ...patch }, options)).toBe(false);
});
