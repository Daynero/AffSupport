import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { requireProcessUploadProducer } from '../supabase/functions/drive-ops/process-output-upload';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  requireDriveSpace,
  spaceStorageBackendOf
} from '../supabase/functions/_shared/space-storage-backend';
import {
  handleRecovery,
  type RecoveryHandlerDeps
} from '../supabase/functions/team-recovery/handler';

/**
 * 057 T019 — the old Drive paths never serve or write an R2 space (T020). What the database
 * refuses is proven in supabase/tests/database/space-storage-isolation.test.sql; here: the Edge
 * side of the same fence — where each path asks, and what it answers.
 */

const TEAM = '05719000-0000-4000-8000-000000000011';
const ACTOR = '05719000-0000-4000-8000-000000000001';
const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as TeamFunctionError).code;
  }
};

describe('process output (drive-ops)', () => {
  const protocol2 = { outputUploadProtocolVersion: 2, checksum: 'a'.repeat(32) };

  it('tells a contract-2 agent to update when the run is in an R2 space', () => {
    expect(code(() => requireProcessUploadProducer(protocol2, 'r2'))).toBe('AGENT_UPDATE_REQUIRED');
    expect(code(() => requireProcessUploadProducer({}, 'r2'))).toBe('AGENT_UPDATE_REQUIRED');
  });

  it('sends a protocol-3 agent to space-storage: drive-ops never writes into R2', () => {
    expect(code(() => requireProcessUploadProducer({ outputUploadProtocolVersion: 3 }, 'r2'))).toBe(
      'STORAGE_BACKEND_MISMATCH'
    );
  });

  it('keeps the Drive rule exactly as it was', () => {
    expect(requireProcessUploadProducer(protocol2)).toBe('a'.repeat(32));
    expect(requireProcessUploadProducer(protocol2, 'drive')).toBe('a'.repeat(32));
    expect(code(() => requireProcessUploadProducer({ outputUploadProtocolVersion: 3 }))).toBe(
      'AGENT_UPDATE_REQUIRED'
    );
  });

  it('asks for the backend before it prepares anything for the output', () => {
    const source = readFileSync('supabase/functions/drive-ops/index.ts', 'utf8');
    const start = source.indexOf('async function handleProcessOutputStart(');
    const body = source.slice(start, source.indexOf('\nasync function ', start + 10));
    const check = body.indexOf('spaceStorageBackendOf(service, operation.teamId, grant.actorId)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(body.indexOf('destinationWithClient('));
    expect(check).toBeLessThan(body.indexOf("'service_set_team_operation_intent'"));
    expect(body).toContain("requireProcessUploadProducer(body, 'r2')");
  });
});

describe('file routes (drive-ops contexts, drive-transfer)', () => {
  const client = (answer: {
    data: unknown;
    error: { code?: string; message?: string } | null;
  }) => ({
    rpc: vi.fn(async () => answer)
  });

  it('refuses an R2 space with STORAGE_BACKEND_MISMATCH and lets a Drive space through', async () => {
    const r2 = client({ data: 'r2', error: null });
    await expect(requireDriveSpace(r2, TEAM, ACTOR)).rejects.toMatchObject({
      code: 'STORAGE_BACKEND_MISMATCH',
      status: 409,
      retryable: false
    });
    expect(r2.rpc).toHaveBeenCalledWith('service_space_storage_backend', {
      p_team: TEAM,
      p_actor: ACTOR
    });
    await expect(
      requireDriveSpace(client({ data: 'drive', error: null }), TEAM, ACTOR)
    ).resolves.toBe(undefined);
    // A stranger is answered null by the database and goes on to the route's own refusal.
    await expect(requireDriveSpace(client({ data: null, error: null }), TEAM, ACTOR)).resolves.toBe(
      undefined
    );
  });

  it('reads a database without the lookup as Drive, any other failure as retryable', async () => {
    await expect(
      spaceStorageBackendOf(client({ data: null, error: { code: 'PGRST202' } }), TEAM, ACTOR)
    ).resolves.toBe('drive');
    await expect(
      spaceStorageBackendOf(client({ data: null, error: { code: '57014' } }), TEAM, ACTOR)
    ).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE', retryable: true });
    await expect(
      spaceStorageBackendOf(client({ data: 's3', error: null }), TEAM, ACTOR)
    ).resolves.toBe(null);
  });

  it('drive-transfer checks the backend right after every caller it authorizes for a space', () => {
    const source = readFileSync('supabase/functions/drive-transfer/index.ts', 'utf8');
    const authorized = [...source.matchAll(/const \{ userId \} = await authorizeCaller\(/gu)];
    expect(authorized.length).toBeGreaterThan(0);
    for (const match of authorized) {
      const next = source.slice(match.index, match.index + 400);
      expect(next).toMatch(
        /await requireDriveSpace\((?:configured\.)?service, teamId\.value, userId\)/u
      );
    }
  });

  it('drive-ops resolves every file route through the two guarded contexts', () => {
    const source = readFileSync('supabase/functions/drive-ops/index.ts', 'utf8');
    expect(source).toContain("'service_get_material_operation_context'");
    expect(source).toContain("'service_get_root_operation_context'");
    const migration = readFileSync(
      'supabase/migrations/20261226140000_space_storage_isolation.sql',
      'utf8'
    );
    for (const name of [
      'public.service_get_material_operation_context',
      'public.service_get_root_operation_context'
    ]) {
      const definition = migration.slice(migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
      const body = definition.slice(0, definition.indexOf('$function$;'));
      expect(body).toContain('perform private.require_drive_space(p_team, p_actor);');
    }
  });
});

describe('delegated background work (team-recovery)', () => {
  const SECRET = 'a'.repeat(43);
  const REQUEST = '11111111-1111-4111-8111-111111111111';
  const deps = (rpc: RecoveryHandlerDeps['rpc']): RecoveryHandlerDeps => ({
    user: vi.fn(async () => ACTOR),
    rpc,
    revoke: vi.fn(async () => {}),
    drive: vi.fn(async () => ({ job: null })),
    token: () => SECRET,
    hash: async () => 'hashed'
  });
  const claim = (fields: Record<string, unknown> = {}) =>
    new Request('https://synthetic.test', {
      method: 'POST',
      headers: { 'x-team-recovery-credential': SECRET },
      body: JSON.stringify({ protocolVersion: 2, action: 'claim', requestId: REQUEST, ...fields })
    });

  it('passes the agent’s workspace contract to the database, which decides for an R2 space', async () => {
    const rpc = vi.fn(async () => ({ pending: true }));
    await handleRecovery(claim({ teamWorkspaceContractVersion: 3 }), deps(rpc));
    expect(rpc).toHaveBeenCalledWith('claim', 'hashed', {
      requestId: REQUEST,
      teamWorkspaceContract: 3
    });
  });

  it('sends nothing for today’s agent, so it is read as contract 2', async () => {
    const rpc = vi.fn(async () => ({ pending: true }));
    await handleRecovery(claim(), deps(rpc));
    await handleRecovery(claim({ teamWorkspaceContractVersion: '3' }), deps(rpc));
    expect(rpc).toHaveBeenNthCalledWith(1, 'claim', 'hashed', { requestId: REQUEST });
    expect(rpc).toHaveBeenNthCalledWith(2, 'claim', 'hashed', { requestId: REQUEST });
  });

  it('a contract-2 claim for an R2 space surfaces AGENT_UPDATE_REQUIRED and starts no work', async () => {
    const d = deps(
      vi.fn(async () => {
        throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
      })
    );
    await expect(handleRecovery(claim(), d)).rejects.toMatchObject({
      code: 'AGENT_UPDATE_REQUIRED'
    });
    expect(d.drive).not.toHaveBeenCalled();
  });

  // 057 T106: an R2 credential's steps go to space-storage, as its receipt's member; a Drive one
  // goes to the Drive updater with exactly the body it always had.
  const space = () => ({
    claim: vi.fn(async () => ({ job: null })),
    heartbeat: vi.fn(async () => ({ cancel: false })),
    complete: vi.fn(async () => ({ recorded: true }))
  });
  const step = (action: string, fields: Record<string, unknown> = {}) =>
    new Request('https://synthetic.test', {
      method: 'POST',
      headers: { 'x-team-recovery-credential': SECRET },
      body: JSON.stringify({
        protocolVersion: 2,
        action,
        operationId: REQUEST,
        jobId: REQUEST,
        leaseToken: SECRET,
        ...fields
      })
    });

  it('claims an R2 space’s work from space-storage as the receipt’s member, never from Drive', async () => {
    const rpc = vi.fn(async (action: string) =>
      action === 'claim'
        ? { teamId: TEAM, actorId: ACTOR, storageBackend: 'r2' }
        : { job: null, operationCredential: null }
    );
    const d = { ...deps(rpc), space: space() };
    await handleRecovery(claim({ teamWorkspaceContractVersion: 3, restitchContractVersion: 2 }), d);
    expect(d.space.claim).toHaveBeenCalledWith(ACTOR, { teamId: TEAM, restitchContractVersion: 2 });
    expect(d.drive).not.toHaveBeenCalled();
  });

  it('a Drive claim goes to the Drive updater with the body it always had', async () => {
    const rpc = vi.fn(async (action: string) =>
      action === 'claim'
        ? { teamId: TEAM, actorId: ACTOR }
        : { job: null, operationCredential: null }
    );
    const d = { ...deps(rpc), space: space() };
    await handleRecovery(claim({ restitchContractVersion: 2 }), d);
    expect(d.drive).toHaveBeenCalledWith('claim', SECRET, {
      teamId: TEAM,
      restitchContractVersion: 2
    });
    expect(d.space.claim).not.toHaveBeenCalled();
  });

  it('heartbeats and settles an R2 run through space-storage', async () => {
    const rpc = vi.fn(async (action: string) =>
      action === 'authorize_execute'
        ? {
            teamId: TEAM,
            actorId: ACTOR,
            storageBackend: 'r2',
            operationState: 'succeeded',
            outputRecorded: true
          }
        : {}
    );
    const d = { ...deps(rpc), space: space() };
    expect(await handleRecovery(step('heartbeat'), d)).toEqual({ cancel: false });
    expect(d.space.heartbeat).toHaveBeenCalledWith(ACTOR, { jobId: REQUEST, leaseToken: SECRET });
    expect(await handleRecovery(step('settle'), d)).toEqual({ settled: true, state: 'succeeded' });
    expect(d.space.complete).toHaveBeenCalledWith(ACTOR, {
      jobId: REQUEST,
      leaseToken: SECRET,
      outcome: 'finalized',
      errorCode: null
    });
    expect(d.drive).not.toHaveBeenCalled();
  });

  it('an R2 run waits to settle until its variation recorded the output', async () => {
    const rpc = vi.fn(async () => ({
      teamId: TEAM,
      actorId: ACTOR,
      storageBackend: 'r2',
      operationState: 'succeeded',
      outputRecorded: false
    }));
    const d = { ...deps(rpc), space: space() };
    expect(await handleRecovery(step('settle'), d)).toEqual({ pending: true });
    expect(d.space.complete).not.toHaveBeenCalled();
  });

  it('without space-storage an R2 claim is refused, not sent to Drive', async () => {
    const rpc = vi.fn(async () => ({ teamId: TEAM, actorId: ACTOR, storageBackend: 'r2' }));
    const d = deps(rpc);
    await expect(handleRecovery(claim(), d)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(d.drive).not.toHaveBeenCalled();
  });

  it('the Edge entry keeps AGENT_UPDATE_REQUIRED from the database as that code', () => {
    const source = readFileSync('supabase/functions/team-recovery/index.ts', 'utf8');
    expect(source).toContain("'AGENT_UPDATE_REQUIRED'");
  });
});

describe('catalog-sync', () => {
  it('the claim names the Drive backend explicitly', () => {
    const migration = readFileSync(
      'supabase/migrations/20261226140000_space_storage_isolation.sql',
      'utf8'
    );
    expect(migration).toContain("sync_space.storage_backend = 'drive'");
    expect(migration).toContain("'private.claim_catalog_sync_jobs(text,integer,integer)'");
  });
});
