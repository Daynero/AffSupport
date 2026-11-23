// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 064: «Запустити N» from the assistant does for each draft what the form does before Generate —
 * catalog video fields filled in, sources read live, saved with the snapshot — and launches the
 * versions that save returned. Found on next 2026-11-22: without it the batch refused a draft
 * the form had never opened with SOURCE_CHANGED.
 */
const api = vi.hoisted(() => ({
  detail: vi.fn(),
  refreshSources: vi.fn(async () => ({ schemaVersion: 1, offer: 'QA' })),
  save: vi.fn(async (input: { id: string }) => ({ id: input.id, version: '7' }))
}));
vi.mock('../apps/web/src/api/launches', () => ({ launchApi: api }));
vi.mock('../apps/web/src/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { launchRows, registerLaunchRunner } from '../apps/web/src/team/assistant/bridge';

const draft = {
  method: 'catalog',
  catalog: { productCount: 50, restitchEnabled: false }
};

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockClear());
  api.detail.mockImplementation(async (_team: string, id: string) => ({
    id,
    version: '3',
    draft
  }));
});

describe('the assistant launching drafts', () => {
  it('refreshes sources and saves each draft before the batch, then launches the saved versions', async () => {
    const runner = vi.fn(async () => undefined);
    const stop = registerLaunchRunner('team', runner);
    await launchRows(
      'team',
      [
        { launchId: 'a', version: '3' },
        { launchId: 'b', version: '3' }
      ],
      'key'
    );
    stop();
    expect(api.refreshSources).toHaveBeenCalledTimes(2);
    const saved = api.save.mock.calls[0]![0] as unknown as {
      version: string;
      config: { catalog: Record<string, unknown> };
      sources: unknown;
    };
    expect(saved.version).toBe('3');
    expect(saved.config.catalog).toMatchObject({
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 1,
      videoPublication: { mode: 'immediate' }
    });
    expect(saved.sources).toEqual({ schemaVersion: 1, offer: 'QA' });
    expect(runner).toHaveBeenCalledWith(
      [
        { launchId: 'a', version: '7' },
        { launchId: 'b', version: '7' }
      ],
      'key'
    );
  });

  it('does not launch a draft changed since the card showed it', async () => {
    const runner = vi.fn(async () => undefined);
    const stop = registerLaunchRunner('team', runner);
    await expect(
      launchRows('team', [{ launchId: 'a', version: '2' }], 'key')
    ).rejects.toMatchObject({
      code: 'REVIEW_CHANGED'
    });
    stop();
    expect(api.save).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
});
