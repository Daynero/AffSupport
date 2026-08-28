// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { waitFor as until } from './support/wait.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSearchResponse, LandingRenderPointer } from '@video-compressor/shared';
import {
  BackgroundRenderProvider,
  useOptionalBackgroundRender,
  type BackgroundRenderClient
} from '../apps/web/src/team/explorer/BackgroundRenderProvider';

/**
 * Feature 011 (T042): landing renders prepared in the background — one at a
 * time, only on a local app that reports the contract, never while this
 * computer is paused, and never redoing a render that is already ready.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const TEAM = 'team-1';

function search(ids: string[]): CatalogSearchResponse {
  return {
    items: ids.map(id => ({ id, teamId: TEAM, name: `${id}.zip`, category: 'landing' })),
    total: ids.length,
    activeFilters: {},
    facets: {},
    catalogFreshness: {
      state: 'ready',
      lastSyncedAt: null,
      discoveredCount: ids.length,
      foldersRemaining: null,
      lastProgressAt: null
    }
  } as unknown as CatalogSearchResponse;
}

function pointer(materialId: string, state: LandingRenderPointer['state']): LandingRenderPointer {
  return { materialId, state, sourceVersion: '1', fingerprint: 'f'.repeat(64), preset: 'default' };
}

function makeClient(renders: LandingRenderPointer[]): BackgroundRenderClient {
  return {
    searchCatalog: vi.fn().mockResolvedValue(search(['a', 'b', 'c'])),
    listLandingRenders: vi.fn().mockResolvedValue(renders),
    startLandingRender: vi.fn(async (_team: string, materialId: string) => ({
      operationId: `op-${materialId}`,
      renderId: `render-${materialId}`,
      teamId: TEAM,
      materialId,
      preset: 'default',
      transferUrl: 'https://t',
      artifactUploadUrl: 'https://u',
      sourceGrant: {
        ticket: 't',
        purpose: 'preview_range',
        expiresAt: 'x',
        maxRangeBytes: 1,
        maxUses: 1
      },
      artifactGrant: {
        ticket: 'a',
        purpose: 'process_output',
        expiresAt: 'x',
        maxRangeBytes: 1,
        maxUses: 1
      }
    })) as unknown as BackgroundRenderClient['startLandingRender']
  };
}

let seen: ReturnType<typeof useOptionalBackgroundRender> = null;
function Probe() {
  seen = useOptionalBackgroundRender();
  return null;
}

describe('BackgroundRenderProvider', () => {
  it('renders the landings without a ready render one at a time, oldest first', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const renderJob = vi.fn(async (job: { materialId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(job.materialId);
      // A microtask is enough to prove the loop waits for one render before the next.
      await Promise.resolve();
      inFlight -= 1;
      return {
        renderId: `render-${job.materialId}`,
        state: 'ready',
        segmentCount: 1,
        fingerprint: 'f'.repeat(64)
      };
    });
    const renders: LandingRenderPointer[] = [pointer('b', 'ready')];
    const client = makeClient(renders);
    // After a render lands, the next look sees it as ready.
    (client.listLandingRenders as ReturnType<typeof vi.fn>).mockImplementation(async () => [
      ...renders,
      ...order.map(id => pointer(id, 'ready'))
    ]);
    render(
      <BackgroundRenderProvider
        teamId={TEAM}
        client={client}
        agent={{
          paired: true,
          toolContracts: { teamWorkspace: 2, teamBackgroundRender: 1 },
          render: renderJob as never
        }}
      >
        <Probe />
      </BackgroundRenderProvider>
    );
    await waitFor(() => expect(order).toEqual(['a', 'c']));
    expect(maxInFlight).toBe(1);
    expect(client.startLandingRender).toHaveBeenCalledTimes(2);
    expect(seen?.available).toBe(true);
  });

  it('does nothing without the contract, and nothing while this computer is paused', async () => {
    const renderJob = vi.fn();
    const client = makeClient([]);
    const { unmount } = render(
      <BackgroundRenderProvider
        teamId={TEAM}
        client={client}
        agent={{ paired: true, toolContracts: { teamWorkspace: 2 }, render: renderJob }}
      >
        <Probe />
      </BackgroundRenderProvider>
    );
    await until(() => seen !== null);
    expect(seen?.available).toBe(false);
    expect(client.searchCatalog).not.toHaveBeenCalled();
    expect(renderJob).not.toHaveBeenCalled();
    unmount();

    localStorage.setItem('soty.team.backgroundRender.paused', '1');
    render(
      <BackgroundRenderProvider
        teamId={TEAM}
        client={client}
        agent={{
          paired: true,
          toolContracts: { teamWorkspace: 2, teamBackgroundRender: 1 },
          render: renderJob
        }}
      >
        <Probe />
      </BackgroundRenderProvider>
    );
    await until(() => seen !== null);
    expect(seen?.paused).toBe(true);
    expect(seen?.available).toBe(true);
    expect(client.searchCatalog).not.toHaveBeenCalled();
    expect(renderJob).not.toHaveBeenCalled();
  });
});
