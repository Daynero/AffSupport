import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  runPreviewWarmSlice,
  type PreviewWarmDependencies,
  type PreviewWarmRow
} from '../supabase/functions/_shared/preview-warm';

/**
 * Feature 011 (T040): the preview warm pass. Each claimed material ends as
 * ready (bytes stored, version recorded) or unavailable with a reason; provider
 * pressure stops the pass and leaves the rest pending for the next tick.
 */
function row(index: number, overrides: Partial<PreviewWarmRow> = {}): PreviewWarmRow {
  return {
    materialId: `material-${index}`,
    teamId: 'team-1',
    connectionId: 'connection-1',
    credentialId: 'credential-1',
    driveFileId: `drive-${index}`,
    resourceKey: null,
    driveVersion: `v${index}`,
    mimeType: 'image/png',
    ...overrides
  };
}

function dependencies(overrides: Partial<PreviewWarmDependencies> = {}) {
  const deps: PreviewWarmDependencies = {
    getFile: vi.fn(async () => ({
      trashed: false,
      mimeType: 'image/png',
      version: 'live-1',
      checksum: 'sum',
      thumbnailLink: 'https://lh3.googleusercontent.com/thumb'
    })),
    fetchThumbnail: vi.fn(async () => ({
      status: 200,
      mimeType: 'image/jpeg',
      bytes: new Uint8Array(1024)
    })),
    store: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    ...overrides
  };
  return deps;
}

describe('runPreviewWarmSlice', () => {
  it('stores each provider thumbnail and commits it against the live version', async () => {
    const deps = dependencies();
    const summary = await runPreviewWarmSlice([row(1), row(2)], deps);
    expect(summary).toEqual({ ready: 2, unavailable: 0, deferred: 0, stoppedEarly: null });
    expect(deps.store).toHaveBeenCalledTimes(2);
    expect(deps.store).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{2}\/[0-9a-f]{64}\.thumbnail$/u),
      expect.any(Uint8Array),
      'image/jpeg'
    );
    expect(deps.commit).toHaveBeenCalledWith(
      expect.objectContaining({ materialId: 'material-1' }),
      {
        state: 'ready',
        version: 'live-1'
      }
    );
  });

  it('records the reason when the provider has nothing, refuses, or hands back the wrong thing', async () => {
    const deps = dependencies({
      getFile: vi
        .fn()
        .mockResolvedValueOnce({
          trashed: true,
          mimeType: 'image/png',
          version: 'v',
          checksum: null,
          thumbnailLink: 'x'
        })
        .mockResolvedValueOnce({
          trashed: false,
          mimeType: 'image/png',
          version: 'v',
          checksum: null,
          thumbnailLink: null
        })
        .mockResolvedValue({
          trashed: false,
          mimeType: 'image/png',
          version: 'v',
          checksum: null,
          thumbnailLink: 'https://lh3.googleusercontent.com/t'
        }),
      fetchThumbnail: vi
        .fn()
        .mockResolvedValueOnce({ status: 403, mimeType: 'image/jpeg', bytes: new Uint8Array(1) })
        .mockResolvedValueOnce({ status: 200, mimeType: 'text/html', bytes: new Uint8Array(1) })
        .mockResolvedValueOnce({
          status: 200,
          mimeType: 'image/jpeg',
          bytes: new Uint8Array(5 * 1024 * 1024)
        })
    });
    const summary = await runPreviewWarmSlice([row(1), row(2), row(3), row(4), row(5)], deps);
    expect(summary).toEqual({ ready: 0, unavailable: 5, deferred: 0, stoppedEarly: null });
    const reasons = (deps.commit as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1]);
    expect(reasons).toEqual([
      { state: 'unavailable', reason: 'provider_missing' },
      { state: 'unavailable', reason: 'provider_missing' },
      { state: 'unavailable', reason: 'protected' },
      { state: 'unavailable', reason: 'unsupported' },
      { state: 'unavailable', reason: 'too_large' }
    ]);
    expect(deps.store).not.toHaveBeenCalled();
  });

  it('stops on provider pressure and leaves the rest pending, but skips a single broken file', async () => {
    const limited = dependencies({
      fetchThumbnail: vi
        .fn()
        .mockResolvedValueOnce({ status: 200, mimeType: 'image/png', bytes: new Uint8Array(10) })
        .mockRejectedValueOnce(new TeamFunctionError('RATE_LIMITED', { retryable: true }))
    });
    const summary = await runPreviewWarmSlice([row(1), row(2), row(3), row(4)], limited);
    expect(summary).toEqual({
      ready: 1,
      unavailable: 0,
      deferred: 3,
      stoppedEarly: 'RATE_LIMITED'
    });
    expect(limited.commit).toHaveBeenCalledTimes(1);

    const broken = dependencies({
      getFile: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
        trashed: false,
        mimeType: 'image/png',
        version: 'v',
        checksum: null,
        thumbnailLink: 'https://lh3.googleusercontent.com/t'
      })
    });
    const after = await runPreviewWarmSlice([row(1), row(2)], broken);
    expect(after).toEqual({ ready: 1, unavailable: 1, deferred: 0, stoppedEarly: null });
    expect(broken.commit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ materialId: 'material-1' }),
      {
        state: 'unavailable',
        reason: 'provider_missing'
      }
    );
  });
});
