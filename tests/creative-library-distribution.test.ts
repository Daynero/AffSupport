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

  it('supports an optional per-video source scope and rejects duplicate capability claims', () => {
    expect(
      parseLibraryJobClaim({
        teamId: TEAM_ID,
        agentInstanceId: AGENT_ID,
        supportedKinds: ['transcription'],
        interfaceLanguage: 'uk',
        sourceMaterialId: SOURCE_ID
      })
    ).toMatchObject({ sourceMaterialId: SOURCE_ID });
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
  });
});
