import { describe, expect, it } from 'vitest';
import {
  SPACE_STORAGE_ERROR_CODES,
  SPACE_STORAGE_JOURNAL_STAGES
} from '../packages/shared/src/team/space-storage';
import { CODE_MAP, lookupCodeLocations } from '../scripts/analytics/code-map';
import { COVERAGE_REGISTRY } from '../scripts/analytics/coverage-registry';
import {
  SPACE_STORAGE_JOURNAL_COLUMNS,
  spaceStorageJournalParams,
  writeSpaceStorageJournal
} from '../supabase/functions/_shared/space-storage-journal';

/**
 * 057 T012 — every storage code points at code, and the storage journal row
 * carries no name, path or key (FR privacy, AGENTS.md «Analytics coverage»).
 */

const TEAM = '57000000-0000-4000-8000-000000000001';
const OPERATION = '57000000-0000-4000-8000-0000000000a1';
const entry = {
  operationId: OPERATION,
  attempt: 1,
  stage: 'complete' as const,
  outcome: 'rejected' as const,
  code: 'CHECKSUM_MISMATCH' as const,
  bytes: 9_007_199_254_740_993n,
  teamId: TEAM,
  ingress: 'explorer' as const,
  client: { kind: 'web' as const, version: '1.8.0' }
};

describe('code map', () => {
  it('names every 057 code, and unknown evidence too', () => {
    for (const code of [...SPACE_STORAGE_ERROR_CODES, 'UNKNOWN']) {
      const key = `space:storage:${code}`;
      expect(CODE_MAP[key], key).toBeDefined();
      expect(lookupCodeLocations(key)?.matched).toBe(key);
      expect(CODE_MAP[key]!.files.length).toBeGreaterThan(0);
    }
    expect(CODE_MAP['space:storage:CHECKSUM_MISMATCH']!.files).toContain(
      'supabase/functions/_shared/r2-space.ts'
    );
    expect(CODE_MAP['space:storage:STORAGE_UNAVAILABLE']!.files).toContain(
      'supabase/functions/_shared/r2-space.ts'
    );
  });

  it('registers team.space_storage as a capability read from the journal table', () => {
    const capability = COVERAGE_REGISTRY.find(entry => entry.id === 'team.space_storage');
    expect(capability).toBeDefined();
    expect(capability!.source).toBe('authoritative_table');
    for (const stage of capability!.stages)
      expect(SPACE_STORAGE_JOURNAL_STAGES as readonly string[]).toContain(stage);
    expect(capability!.unobservable.length).toBeGreaterThan(0);
  });
});

describe('storage journal', () => {
  it('has no column for a name, a path or a key', () => {
    for (const column of SPACE_STORAGE_JOURNAL_COLUMNS)
      expect(column).not.toMatch(/name|path|key|url|grant|email/u);
    expect([...SPACE_STORAGE_JOURNAL_COLUMNS].sort()).toEqual(
      [
        'operation_id',
        'attempt',
        'stage',
        'outcome',
        'code',
        'bytes',
        'team_id',
        'ingress',
        'client'
      ].sort()
    );
  });

  it('builds the row from the closed fields only and keeps bytes exact', () => {
    const params = spaceStorageJournalParams(entry);
    expect(params).toEqual({
      p_operation: OPERATION,
      p_attempt: 1,
      p_stage: 'complete',
      p_outcome: 'rejected',
      p_code: 'CHECKSUM_MISMATCH',
      p_bytes: '9007199254740993',
      p_team: TEAM,
      p_ingress: 'explorer',
      p_client: 'web/1.8.0'
    });
  });

  it('refuses a row that carries a name, a path, a key or an unknown value', () => {
    for (const extra of [
      { name: 'Contract.pdf' },
      { path: '/Users/someone/video.mp4' },
      { key: `t/${TEAM}/o/${'a'.repeat(64)}` },
      { r2Key: 'x' }
    ])
      expect(spaceStorageJournalParams({ ...entry, ...extra }), JSON.stringify(extra)).toBeNull();
    expect(spaceStorageJournalParams({ ...entry, stage: 'upload' })).toBeNull();
    expect(spaceStorageJournalParams({ ...entry, code: 'Free text' })).toBeNull();
    expect(
      spaceStorageJournalParams({ ...entry, client: { kind: 'web', version: '../x' } })
    ).toBeNull();
    expect(spaceStorageJournalParams({ ...entry, bytes: -1n })).toBeNull();
    expect(
      spaceStorageJournalParams({ ...entry, code: null, bytes: null, ingress: null })
    ).toMatchObject({
      p_code: null,
      p_bytes: null,
      p_ingress: null
    });
  });

  it('writes through the service RPC and never fails the operation it describes', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ok = await writeSpaceStorageJournal(
      {
        rpc: async (name, parameters) => {
          calls.push([name, parameters]);
          return { data: null, error: null };
        }
      },
      entry
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      ['service_write_space_storage_journal', spaceStorageJournalParams(entry)]
    ]);
    expect(
      await writeSpaceStorageJournal(
        { rpc: async () => ({ data: null, error: { message: 'connection refused' } }) },
        entry
      )
    ).toBe(false);
    expect(
      await writeSpaceStorageJournal(
        {
          rpc: async () => {
            throw new Error('network');
          }
        },
        entry
      )
    ).toBe(false);
    expect(
      await writeSpaceStorageJournal(
        { rpc: async () => ({ data: null, error: null }) },
        { name: 'x' }
      )
    ).toBe(false);
  });
});
