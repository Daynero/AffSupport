import { describe, expect, it } from 'vitest';
import { parseTeamTaskDetachResult } from '@video-compressor/shared';

describe('task detach receipt contract', () => {
  const receipt = {
    detached: true,
    state: 'waiting',
    intentId: 'bd370000-0000-4000-8000-000000000041',
    detachedAt: '2026-10-09T10:00:00Z',
    undoDeadline: '2026-10-09T10:00:30Z'
  };

  it('keeps the server deadline and explicit cleanup state', () => {
    expect(parseTeamTaskDetachResult(receipt)).toEqual(receipt);
    expect(parseTeamTaskDetachResult({ ...receipt, state: 'cleanup_unverified' })?.state).toBe(
      'cleanup_unverified'
    );
    expect(parseTeamTaskDetachResult({ detached: false, state: 'already_detached' })).toMatchObject(
      { detached: false, undoDeadline: null }
    );
  });

  it('rejects malformed deadlines, unknown outcomes and private payloads', () => {
    expect(parseTeamTaskDetachResult({ ...receipt, undoDeadline: 'soon' })).toBeNull();
    expect(parseTeamTaskDetachResult({ ...receipt, state: 'storage_reclaimed' })).toBeNull();
    expect(parseTeamTaskDetachResult({ ...receipt, intentId: '/private/file' })).toBeNull();
    expect(
      JSON.stringify(parseTeamTaskDetachResult({ ...receipt, path: '/private/file' }))
    ).not.toContain('/private/file');
  });
});
