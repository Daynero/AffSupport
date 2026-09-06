import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_JOB_HEARTBEAT_SECONDS,
  LIBRARY_JOB_LEASE_SECONDS,
  parseLibraryJobClaim,
  parseLibraryJobHeartbeat
} from '@video-compressor/shared';

const TEAM_ID = '44000000-0000-4000-8000-000000000001';
const AGENT_ID = '44000000-0000-4000-8000-000000000002';
const SOURCE_ID = '44000000-0000-4000-8000-000000000003';

describe('Creative Library distributed lease contract', () => {
  it('keeps heartbeat comfortably inside the bounded lease window', () => {
    expect(LIBRARY_JOB_HEARTBEAT_SECONDS).toBeGreaterThan(0);
    expect(LIBRARY_JOB_HEARTBEAT_SECONDS * 2).toBeLessThanOrEqual(LIBRARY_JOB_LEASE_SECONDS);
    expect(
      parseLibraryJobHeartbeat({
        teamId: TEAM_ID,
        attemptId: SOURCE_ID,
        agentInstanceId: AGENT_ID,
        leaseToken: 'lease-token-with-enough-entropy-123',
        progress: 100,
        stage: 'finalizing'
      })
    ).not.toBeNull();
  });

  it('scopes a claim to a chosen set and rejects duplicate capability claims', () => {
    // One file, several, or none at all: the scope is a set, so a folder and a
    // hand-picked selection are the same request at a different size.
    expect(
      parseLibraryJobClaim({
        teamId: TEAM_ID,
        agentInstanceId: AGENT_ID,
        supportedKinds: ['transcription'],
        interfaceLanguage: 'uk',
        sourceMaterialIds: [SOURCE_ID]
      })
    ).toMatchObject({ sourceMaterialIds: [SOURCE_ID] });
    expect(
      parseLibraryJobClaim({
        teamId: TEAM_ID,
        agentInstanceId: AGENT_ID,
        supportedKinds: ['transcription'],
        interfaceLanguage: 'uk',
        sourceMaterialIds: [SOURCE_ID, AGENT_ID, SOURCE_ID]
      })
    ).toMatchObject({ sourceMaterialIds: [SOURCE_ID, AGENT_ID] });
    expect(
      parseLibraryJobClaim({
        teamId: TEAM_ID,
        agentInstanceId: AGENT_ID,
        supportedKinds: ['transcription'],
        interfaceLanguage: 'uk',
        sourceMaterialIds: ['not-a-uuid']
      })
    ).toBeNull();
    expect(
      parseLibraryJobClaim({
        teamId: TEAM_ID,
        agentInstanceId: AGENT_ID,
        supportedKinds: ['transcription', 'transcription'],
        interfaceLanguage: 'uk'
      })
    ).toBeNull();
  });

  it('guards transactional skip-locked claims, expiry/reclaim and first-current-result uniqueness', () => {
    const sql = readFileSync(
      new URL(
        '../supabase/migrations/20260814101000_creative_library_actions.sql',
        import.meta.url
      ),
      'utf8'
    );
    const foundation = readFileSync(
      new URL(
        '../supabase/migrations/20260814100000_creative_library_foundation.sql',
        import.meta.url
      ),
      'utf8'
    );
    expect(sql).toMatch(/for update of candidate skip locked/u);
    expect(sql).toMatch(/set state = 'expired'/u);
    expect(sql).toMatch(/lease_expires_at <= clock_timestamp\(\)/u);
    expect(sql).toMatch(/candidate\.state = 'pending'/u);
    expect(foundation).toMatch(
      /team_library_results_one_current_idx[\s\S]+where state = 'current'/u
    );

    /*
     * The guard has to hold for the definition the database is actually
     * running, not only for the one that introduced it. `claim_library_job`
     * has been replaced twice since — for the catalog's null `library_stage`,
     * and for the array scope — and a rewrite that dropped the skip-locked
     * clause would have sailed past a test reading the 2026-08 file.
     */
    const current = readFileSync(
      new URL('../supabase/migrations/20260906030000_library_scope_is_a_set.sql', import.meta.url),
      'utf8'
    );
    expect(current).toMatch(/for update of candidate skip locked/u);
    expect(current).toMatch(/set state = 'expired'/u);
    expect(current).toMatch(/candidate\.state = 'pending'/u);
    // The scope is applied to the claim, not only to the scan.
    expect(current).toMatch(/scope is null or candidate\.source_material_id = any\(scope\)/u);
  });

  it('carries a finished landing optimisation across the variant rename', () => {
    const rename = readFileSync(
      new URL(
        '../supabase/migrations/20260906070000_landing_variant_keeps_its_history.sql',
        import.meta.url
      ),
      'utf8'
    );
    // A finished optimisation is `ready`, and `ready` rows kept the language
    // variant. Retiring only the pending and failed ones would have offered a
    // fresh job for every landing that was already done.
    expect(rename).toMatch(/when 'ready' then 0/u);
    expect(rename).toMatch(/variant = 'default'[\s\S]*rank = 1/u);
    // The retired row keeps its place in the table, so it has to step off the
    // key the survivor is about to take.
    expect(rename).toMatch(/variant = 'retired:[\s\S]*rank > 1/u);
  });

  it('walks a folder subtree in one bounded, scoped read', () => {
    const sql = readFileSync(
      new URL(
        '../supabase/migrations/20260906090000_folder_subtree_in_one_read.sql',
        import.meta.url
      ),
      'utf8'
    );
    // The browser used to ask one folder at a time, up to five hundred times.
    expect(sql).toMatch(/with recursive walk as/u);
    // Bounded twice: by depth, so a shortcut cycle cannot spin, and by the
    // folder ceiling the window then reports honestly.
    expect(sql).toMatch(/walk\.depth < 64/u);
    expect(sql).toMatch(/count\(\*\) from capped\) > p_max_folders/u);
    // The same gate every other read in this space carries, and the same
    // housekeeping rule the list and the tree use.
    expect(sql).toMatch(/private\.can\(p_team, 'view', actor\)/u);
    expect(sql).toMatch(/not private\.is_housekeeping_name\(material\.name\)/u);
    expect(sql).toMatch(/revoke all on function public\.list_team_folder_subtree/u);
  });

  it('counts a folder once, by one rule', () => {
    const sql = readFileSync(
      new URL(
        '../supabase/migrations/20260906080000_one_rule_for_housekeeping.sql',
        import.meta.url
      ),
      'utf8'
    );
    // The tree's badge and the list's total disagreed by the number of
    // `.DS_Store`s, because only the browser knew the rule.
    expect(sql).toMatch(/create or replace function private\.is_housekeeping_name/u);
    expect(sql).toMatch(/'\.ds_store', 'thumbs\.db', 'desktop\.ini', '_organize_log\.json'/u);
    const uses = sql.match(/private\.is_housekeeping_name\(/gu) ?? [];
    // Once in the definition, once in the tree's count, twice in the page (its
    // total and its rows).
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it('counts without queueing, and lets retired work come back', () => {
    const counting = readFileSync(
      new URL(
        '../supabase/migrations/20260906100000_counting_is_not_queueing.sql',
        import.meta.url
      ),
      'utf8'
    );
    // Opening the window used to write a requirement row for every job it
    // counted, for the whole space, while saying nothing starts without
    // confirmation. A dry read counts the candidates instead.
    expect(counting).toMatch(/p_commit boolean default true/u);
    expect(counting).toMatch(/where p_commit/u);
    expect(counting).toMatch(/missing_transcriptions := candidate_transcriptions;/u);

    const revive = readFileSync(
      new URL(
        '../supabase/migrations/20260906110000_stale_work_can_come_back.sql',
        import.meta.url
      ),
      'utf8'
    );
    // A retired row keeps the unique key, so `do nothing` dropped the job for
    // good: the window offered it and the claim loop could never find it.
    expect(revive).toMatch(/do update set state = 'pending', last_error_code = null/u);
    // And nothing further along is disturbed — a finished job stays finished.
    expect(revive).toMatch(/where public\.team_library_requirements\.state = 'stale'/u);
    expect(revive.match(/do update set state = 'pending'/gu) ?? []).toHaveLength(3);
  });

  it('offers only work the claim loop can take', () => {
    const sql = readFileSync(
      new URL(
        '../supabase/migrations/20260906120000_offered_work_can_be_claimed.sql',
        import.meta.url
      ),
      'utf8'
    );
    // `claim_library_job` takes `pending` only, so a `failed` row counted in the
    // numbers over Start was a job that could never run. Pressing Start asks for
    // it; the retry button already meant that.
    expect(sql).toMatch(/state in \('stale', 'failed'\)/u);
    // A finished job whose result was trashed is not finished — and the video's
    // version did not change, so nothing else would have noticed.
    expect(sql).toMatch(/requirement\.state = 'ready'[\s\S]*produced\.lifecycle = 'active'/u);
    // Reviving a failed row must not offer work that is no longer warranted.
    expect(sql).toMatch(/requirement\.state in \('pending', 'failed'\)/u);
  });

  it('says when a read was cut short by depth, not only by breadth', () => {
    // In its own migration rather than as an edit to 090000: migrations are
    // tracked by filename, so an environment that already ran that file would
    // never have picked an in-place change up.
    const sql = readFileSync(
      new URL(
        '../supabase/migrations/20260906130000_a_deep_read_says_it_was_cut.sql',
        import.meta.url
      ),
      'utf8'
    );
    expect(sql).toMatch(/max\(depth\) from capped\), 0\) >= 64/u);
  });
});
