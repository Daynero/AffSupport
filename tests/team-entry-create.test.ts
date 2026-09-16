import { describe, expect, it } from 'vitest';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { resolveTeamEntry } from '../apps/web/src/team/TeamSpace';

/**
 * T109 — "Create a new space" from inside a space (024, FR-048).
 *
 * The resolver answers a bare `/team` by entering a space — one ready space,
 * or the remembered one. The wizard's own address must not be answered that
 * way: entering a space underneath the wizard would navigate straight past it.
 */
describe('the new-space address', () => {
  const ready = {
    id: 'space-1',
    name: 'Ready',
    role: 'owner',
    connectionState: 'connected'
  } as unknown as TeamContextSnapshot;

  it('stays put instead of entering the only space', () => {
    const entry = resolveTeamEntry({
      route: { kind: 'resolver', driveReturn: null, showAll: false, create: true },
      teams: [ready],
      teamsLoaded: true,
      pendingInvitations: 0,
      rememberedTeamId: 'space-1',
      driveTarget: null
    });
    expect(entry.kind).toBe('lobby');
  });
});
