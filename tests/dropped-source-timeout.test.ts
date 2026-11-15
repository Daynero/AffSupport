import { describe, expect, it, vi } from 'vitest';

// A protected folder whose permission question is still on screen: the read never settles.
vi.mock('../apps/agent/src/platform/platform.js', async original => ({
  ...(await original<typeof import('../apps/agent/src/platform/platform.js')>()),
  userContentFolders: () => new Promise<string[]>(() => undefined),
  indexedFileSearch: async () => []
}));

import {
  DROPPED_SOURCE_LOOKUP_TIMEOUT_MS,
  findDroppedSource
} from '../apps/agent/src/files/dropped-source.js';

describe('looking for a dropped original', () => {
  it('gives up after a bounded wait so the drop goes ahead with the uploaded copy', async () => {
    const started = Date.now();
    await expect(findDroppedSource('clip.webm', 2_000, 1, 50)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('waits a few seconds by default, not indefinitely', () => {
    expect(DROPPED_SOURCE_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DROPPED_SOURCE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
