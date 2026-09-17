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

  it('marks a shared task link when the reader is not in that space (024)', () => {
    // The screen must stay one answer for "gone" and for "not yours", but it may say what the
    // link was for — the address already carried it.
    const shared = resolveTeamEntry({
      route: {
        kind: 'space',
        spaceId: 'space-9',
        section: 'tasks',
        query: { taskId: 'task-1' },
        driveReturn: null
      } as never,
      teams: [ready],
      teamsLoaded: true,
      pendingInvitations: 0,
      rememberedTeamId: null,
      driveTarget: null
    });
    expect(shared).toEqual({ kind: 'no-access', taskLink: true });

    const plain = resolveTeamEntry({
      route: {
        kind: 'space',
        spaceId: 'space-9',
        section: 'explorer',
        query: {},
        driveReturn: null
      } as never,
      teams: [ready],
      teamsLoaded: true,
      pendingInvitations: 0,
      rememberedTeamId: null,
      driveTarget: null
    });
    expect(plain).toEqual({ kind: 'no-access', taskLink: false });
  });
});
