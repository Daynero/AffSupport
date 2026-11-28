import { describe, expect, it, vi } from 'vitest';
import {
  importSpaceReadGrantKey,
  verifySpaceReadGrant
} from '../packages/shared/src/team/space-read-grant';
import {
  parseSpaceReadGrantResult,
  spaceFilesUrl
} from '../packages/shared/src/team/space-storage';
import type { SpaceStorageJournalEntry } from '../supabase/functions/_shared/space-storage-journal';
import { issueReadGrant, readSpaceReadGrantConfig } from '../supabase/functions/space-storage/read';

/** 057 T026/T027 — `/read-grant`: one space, ≤10 minutes, bound to the current access epoch. */

const ACTOR = '05727000-0000-4000-8000-000000000001';
const TEAM = '05727000-0000-4000-8000-000000000011';
const OTHER = '05727000-0000-4000-8000-000000000012';
const RAW = new Uint8Array(32).fill(9);
const env =
  (overrides: Record<string, string | undefined> = {}) =>
  (name: string) =>
    ({
      CATALOG_IMAGES_ENVIRONMENT: 'beta',
      SPACE_FILES_ORIGIN: 'https://files-beta.soty.pp.ua',
      SPACE_READ_GRANT_KEY_VERSION: '1',
      SPACE_READ_GRANT_KEYS: JSON.stringify({ '1': Buffer.from(RAW).toString('base64') }),
      ...overrides
    })[name];

function context(allowed: boolean, epoch = '7') {
  return vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe('service_space_storage_context');
    expect(args.p_permission).toBe('view');
    return {
      member: true,
      storageBackend: 'r2',
      storagePilot: false,
      actorPilot: false,
      workspaceAllowed: true,
      archived: false,
      allowed,
      accessEpoch: epoch,
      contentRevision: '0',
      rootMaterialId: null
    };
  });
}

describe('read grant', () => {
  it('signs one space for ten minutes at its current epoch, and never journals the grant', async () => {
    const journal: SpaceStorageJournalEntry[] = [];
    const config = await readSpaceReadGrantConfig(env());
    const result = await issueReadGrant(
      { teamId: TEAM },
      {
        actorId: ACTOR,
        rpc: context(true),
        config,
        journal: async entry => {
          journal.push(entry);
          return true;
        },
        operationId: '05727000-0000-4000-8000-0000000000ff',
        client: { kind: 'web', version: '1.8.0+110' },
        nowSeconds: () => 1_800_000_000
      }
    );
    expect(parseSpaceReadGrantResult(result).ok).toBe(true);
    expect(result.filesOrigin).toBe('https://files-beta.soty.pp.ua');
    expect(result.expiresAt).toBe(new Date((1_800_000_000 + 600) * 1000).toISOString());
    const keys = new Map([[1, await importSpaceReadGrantKey(RAW)]]);
    const verdict = await verifySpaceReadGrant(result.grant, {
      environment: 'beta',
      keys,
      teamId: TEAM,
      nowSeconds: 1_800_000_001,
      currentEpoch: 7n
    });
    expect(verdict).toMatchObject({ ok: true, claims: { userId: ACTOR, accessEpoch: 7n } });
    expect(
      await verifySpaceReadGrant(result.grant, {
        environment: 'beta',
        keys,
        teamId: OTHER,
        nowSeconds: 1_800_000_001
      })
    ).toEqual({ ok: false, reason: 'team' });
    expect(
      await verifySpaceReadGrant(result.grant, {
        environment: 'beta',
        keys,
        teamId: TEAM,
        nowSeconds: 1_800_000_001,
        currentEpoch: 8n
      })
    ).toEqual({ ok: false, reason: 'epoch' });
    expect(JSON.stringify(journal)).not.toContain(result.grant);
    expect(journal.map(entry => entry.stage)).toEqual(['read_grant']);
    const url = spaceFilesUrl({
      filesOrigin: result.filesOrigin,
      teamId: TEAM,
      contentId: 'a'.repeat(64),
      grant: result.grant,
      download: 'Кліп.mp4'
    });
    expect(url.startsWith(`https://files-beta.soty.pp.ua/t/${TEAM}/o/${'a'.repeat(64)}?g=`)).toBe(
      true
    );
    expect(new URL(url).searchParams.get('dl')).toBe('Кліп.mp4');
  });

  it('a person without view gets none; an unprovisioned key is STORAGE_UNAVAILABLE', async () => {
    const base = {
      actorId: ACTOR,
      journal: async () => true,
      operationId: '05727000-0000-4000-8000-0000000000ff',
      client: { kind: 'web' as const, version: '1.8.0+110' }
    };
    const config = await readSpaceReadGrantConfig(env());
    await expect(
      issueReadGrant({ teamId: TEAM }, { ...base, rpc: context(false), config })
    ).rejects.toThrow('PERMISSION_DENIED');
    await expect(
      issueReadGrant({ teamId: TEAM }, { ...base, rpc: context(true), config: null })
    ).rejects.toThrow('STORAGE_UNAVAILABLE');
  });

  it('reads its configuration strictly', async () => {
    expect(await readSpaceReadGrantConfig(env({ SPACE_FILES_ORIGIN: 'http://files' }))).toBeNull();
    expect(await readSpaceReadGrantConfig(env({ SPACE_READ_GRANT_KEY_VERSION: '2' }))).toBeNull();
    expect(
      await readSpaceReadGrantConfig(env({ CATALOG_IMAGES_ENVIRONMENT: 'staging' }))
    ).toBeNull();
    expect(
      await readSpaceReadGrantConfig(
        env({
          SPACE_READ_GRANT_KEYS: JSON.stringify({
            '1': Buffer.from(new Uint8Array(8)).toString('base64')
          })
        })
      )
    ).toBeNull();
  });
});
