import { afterEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));

const { teamApi } = await import('../apps/web/src/api/team');

afterEach(() => {
  rpc.mockReset();
});

/**
 * The row `public.list_team_audit_events` actually returns, with the column
 * names the function declares — not the camel-cased shape the UI reads, which
 * is what the mapper exists to produce.
 */
function auditRow(target: Record<string, string>) {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    actor_label: 'Beta Tester',
    action: 'task.deleted',
    target,
    result: 'succeeded',
    error_code: null,
    occurred_at: '2026-08-26T20:12:37.673Z'
  };
}

describe('space history over the wire', () => {
  /**
   * Found by driving the real beta stack: deleting one task left Settings
   * reading "Could not load this space's history" forever. The 010 migration
   * widened `private.record_team_audit`'s key whitelist to accept `task_id` and
   * `task_title`, the client's copy of that list was not widened, and an
   * unrecognised key does not drop the row — `listAuditEvents` throws
   * INVALID_RESPONSE for the *whole* page. Each half had a test; nothing tested
   * them against each other, which is exactly where this fell through.
   */
  it('reads back a task.deleted row the server is allowed to write', async () => {
    rpc.mockResolvedValue({
      data: [auditRow({ task_id: 'b4fd7077-7384-49a9-a529-8cb04f8de9ea', task_title: 'QA task' })],
      error: null
    });

    const events = await teamApi.listAuditEvents('22222222-2222-4222-8222-222222222222');

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('task.deleted');
    expect(events[0]?.actorLabel).toBe('Beta Tester');
    expect(events[0]?.result).toBe('succeeded');
  });

  /**
   * The guard the widening must not cost us: the list is a bound on what may
   * reach a client, so a key nobody declared is still refused. It stays
   * all-or-nothing on purpose — a partial history is a history you cannot
   * trust — so this asserts the throw, not a filtered row.
   */
  it('still refuses a target key no one declared', async () => {
    rpc.mockResolvedValue({
      data: [auditRow({ task_id: 'b4fd7077-7384-49a9-a529-8cb04f8de9ea', email: 'a@b.test' })],
      error: null
    });

    await expect(
      teamApi.listAuditEvents('22222222-2222-4222-8222-222222222222')
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
