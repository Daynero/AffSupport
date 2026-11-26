import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import { catalogVideoFunctionBase } from '../supabase/functions/_shared/restitch-native.ts';
import { catalogVideoProcessGrants } from '../supabase/functions/drive-ops/catalog-video-process-grants.ts';

// Incident 2026-11-26: a variant whose process alias was refused with SOURCE_CHANGED stayed
// `running` for good — the agent asks for its grants before it owns anything it could close —
// and the launch showed an unrelated error. The set's snapshot is immutable, so that refusal
// never passes later: the function closes the variant with the cause it was given.
const id = (n: number) => '17100000-0000-4000-8000-' + String(n).padStart(12, '0');
const native = {
  setId: id(1),
  nativeInstanceId: id(5),
  claimHash: 'synthetic-hash',
  protocolVersion: 1 as const
};
const child = { index: 0, requestId: id(10), operationId: id(50) };
const settings = {
  configured: true,
  operation: 'restitch',
  sourceMode: 'drive',
  fitMode: 'cover',
  startDurationMode: 'one-frame',
  customStartDurationMs: 1,
  startEnabled: true,
  endEnabled: true,
  finalDurationMode: 'random-centered',
  finalDurationRangeSeconds: [600, 660],
  customFinalDurationSeconds: 2700
};
function service(complete: () => Promise<{ error: { message: string } | null; data: unknown }>) {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === 'service_complete_catalog_video_variant') return complete();
      return {
        error: null,
        data:
          name === 'service_authorize_catalog_video_executor'
            ? {
                setId: id(1),
                teamId: id(2),
                actorId: id(3),
                executorId: id(4),
                epoch: 1,
                nativeInstanceId: id(5)
              }
            : name === 'service_read_catalog_video_process_context'
              ? {
                  operationId: id(50),
                  operationState: 'running',
                  teamId: id(2),
                  actorId: id(3),
                  destinationFolderId: null,
                  materialId: id(6),
                  sourceVersion: '1',
                  settings,
                  settingsDigest: 'b'.repeat(64),
                  sourceSizeBytes: 1024
                }
              : name === 'service_reserve_catalog_video_grants'
                ? {
                    sourceTicketId: id(70),
                    finalizeTicketId: id(71),
                    expiresAt: '2026-11-26T12:00:00.000Z',
                    acquisition: 0
                  }
                : true
      };
    })
  };
}
const grants = (
  rpc: ReturnType<typeof service>,
  prepareAlias: () => Promise<{ rootOperationId: string; selectionProtocol: 1; defaults: never }>
) =>
  catalogVideoProcessGrants(rpc, native, {
    functionBase: catalogVideoFunctionBase('beta'),
    secret: 'synthetic-secret',
    prepareAlias
  })(child);
const closed = async () => ({
  error: null,
  data: { kind: 'terminal', operationId: id(50), state: 'failed' }
});

describe('a process alias refused for a changed source', () => {
  it('closes the variant as failed with SOURCE_CHANGED and still answers SOURCE_CHANGED', async () => {
    const rpc = service(closed);
    await expect(
      grants(rpc, async () => {
        throw new TeamFunctionError('SOURCE_CHANGED');
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(rpc.rpc).toHaveBeenCalledWith('service_complete_catalog_video_variant', {
      p_set: id(1),
      p_hash: 'synthetic-hash',
      p_native: id(5),
      p_protocol: 1,
      p_index: 0,
      p_request: id(10),
      p_operation: id(50),
      p_outcome: 'failed',
      p_code: 'SOURCE_CHANGED'
    });
    // The grants of a process that will not run are never issued.
    expect(rpc.rpc.mock.calls.map(call => call[0])).not.toContain(
      'service_issue_catalog_video_grants'
    );
  });

  it('answers the original refusal when the close itself is refused or lost', async () => {
    for (const complete of [
      async () => ({ error: { message: 'PERMISSION_DENIED' }, data: null }),
      async () => {
        throw new Error('network');
      }
    ]) {
      const rpc = service(complete);
      await expect(
        grants(rpc, async () => {
          throw new TeamFunctionError('SOURCE_CHANGED');
        })
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    }
  });

  it('closes nothing for a refusal that may pass on a later try', async () => {
    for (const code of [
      'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
      'REQUEST_REUSE_CONFLICT',
      'PERMISSION_DENIED',
      'AUTH_REQUIRED',
      'RATE_LIMITED'
    ] as const) {
      const rpc = service(closed);
      await expect(
        grants(rpc, async () => {
          throw new TeamFunctionError(code);
        })
      ).rejects.toMatchObject({ code });
      expect(rpc.rpc.mock.calls.map(call => call[0])).not.toContain(
        'service_complete_catalog_video_variant'
      );
    }
    const rpc = service(closed);
    await expect(
      grants(rpc, async () => {
        throw new Error('network');
      })
    ).rejects.toThrow('network');
    expect(rpc.rpc.mock.calls.map(call => call[0])).not.toContain(
      'service_complete_catalog_video_variant'
    );
  });
});
