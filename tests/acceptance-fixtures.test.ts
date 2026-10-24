import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateFixtureState, provisionLocalFixtures } from '../scripts/acceptance/fixtures.mjs';
describe('fixture ownership safety', () => {
  it('rejects unsafe targets before credentials or network are read', async () => {
    await expect(provisionLocalFixtures({ kind: 'production' })).rejects.toThrow(
      'ACCEPTANCE_TARGET_UNSAFE'
    );
  });
  it('accepts only the five synthetic namespace-owned identities', () => {
    const namespace = 'acceptance-test-001';
    const state = {
      namespace,
      actors: Object.fromEntries(
        ['A', 'B', 'C', 'X', 'S'].map(alias => [
          alias,
          {
            id: randomUUID(),
            email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
            password: 'a'.repeat(32),
            provisioned: true
          }
        ])
      ),
      teams: {}
    };
    expect(validateFixtureState(state, namespace).ok).toBe(true);
    expect(validateFixtureState({ ...state, teams: { W1: '../foreign' } }, namespace).ok).toBe(
      false
    );
    expect(validateFixtureState({ ...state, teams: { foreign: randomUUID() } }, namespace).ok).toBe(
      false
    );
    state.actors.A.email = 'real@example.com';
    expect(validateFixtureState(state, namespace).ok).toBe(false);
  });
});
