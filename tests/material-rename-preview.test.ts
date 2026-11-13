import { describe, expect, it, vi } from 'vitest';
import { commitRenameWithPreview } from '../supabase/functions/drive-ops/rename-preview';

const identity = { checksum: 'same-content', size: 512, mimeType: 'video/mp4' };

describe('a renamed file keeps its prepared preview', () => {
  it('restores the new version only after the rename invalidates the old thumbnail', async () => {
    let thumbnail = 'ready:v1';
    const result = await commitRenameWithPreview({
      before: identity,
      after: identity,
      commit: async () => {
        thumbnail = 'pending:v2';
        return { state: 'succeeded', materialId: 'same-material' };
      },
      preserve: async () => {
        expect(thumbnail).toBe('pending:v2');
        thumbnail = 'ready:v2';
      }
    });
    expect(result.state).toBe('succeeded');
    expect(thumbnail).toBe('ready:v2');
  });

  it.each([
    { checksum: 'changed' },
    { checksum: null },
    { size: 513 },
    { size: null },
    { mimeType: 'image/png' },
    { mimeType: null }
  ])('never reuses a thumbnail for changed or unknown content: %j', async change => {
    const preserve = vi.fn();
    await commitRenameWithPreview({
      before: identity,
      after: { ...identity, ...change },
      commit: async () => true,
      preserve
    });
    expect(preserve).not.toHaveBeenCalled();
  });

  it('does not repair a thumbnail when committing the rename fails', async () => {
    const preserve = vi.fn();
    await expect(
      commitRenameWithPreview({
        before: identity,
        after: identity,
        commit: async () => {
          throw new Error('offline');
        },
        preserve
      })
    ).rejects.toThrow('offline');
    expect(preserve).not.toHaveBeenCalled();
  });

  it('does not turn a successful rename into a repeatable mutation after a cache failure', async () => {
    const commit = vi.fn(async () => 'succeeded');
    await expect(
      commitRenameWithPreview({
        before: identity,
        after: identity,
        commit,
        preserve: async () => {
          throw new Error('cache-unavailable');
        }
      })
    ).resolves.toBe('succeeded');
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
