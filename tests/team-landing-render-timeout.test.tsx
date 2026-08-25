// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogMaterialItem,
  LandingRenderPointer,
  TeamLandingRenderJob
} from '../packages/shared/src/team/index';

const api = vi.hoisted(() => ({
  renderTeamLanding: vi.fn(),
  toolEventUrl: vi.fn(() => '')
}));

vi.mock('../apps/web/src/api/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/api/client')>()),
  renderTeamLanding: api.renderTeamLanding,
  toolEventUrl: api.toolEventUrl
}));
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useOptionalAgent: () => ({
    connection: 'connected',
    connectedOnce: true,
    toolContracts: { teamWorkspace: 2 },
    teamWorkspaceAvailable: true
  })
}));

import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamLandings } from '../apps/web/src/team/landings/TeamLandings';

const TEAM_ID = '22000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '33000000-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

const archive: CatalogMaterialItem = {
  id: MATERIAL_ID,
  teamId: TEAM_ID,
  parentFolderId: null,
  name: 'Stalled preview.zip',
  kind: 'file',
  category: 'archive',
  mimeType: 'application/zip',
  fileExtension: 'zip',
  classificationVersion: 1,
  classificationSource: 'extension',
  sizeBytes: 1024,
  modifiedAt: null,
  geo: null,
  language: null,
  offer: null,
  tags: [],
  transcriptIngestState: 'not_applicable',
  transcriptTruncated: false,
  previewState: 'pending',
  lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
};

const job = {
  operationId: '44000000-0000-4000-8000-000000000001',
  renderId: '55000000-0000-4000-8000-000000000001',
  teamId: TEAM_ID,
  materialId: MATERIAL_ID
} as TeamLandingRenderJob;

const failedRender: LandingRenderPointer = {
  materialId: MATERIAL_ID,
  state: 'failed',
  failureReason: 'render_error',
  preset: 'default',
  sourceVersion: '1',
  fingerprint: 'fingerprint-1'
};

describe('team landing render timeout', () => {
  it('returns a hung browser request to an explicit retry state', async () => {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    let listCalls = 0;
    const client = {
      searchCatalog: vi.fn().mockResolvedValue({
        items: [archive],
        total: 1,
        activeFilters: { category: ['landing', 'archive'] },
        facets: {},
        catalogFreshness: { state: 'ready' as const, lastSyncedAt: null }
      }),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      }),
      listLandingRenders: vi
        .fn()
        .mockImplementation(() => Promise.resolve(listCalls++ === 0 ? [] : [failedRender])),
      startLandingRender: vi.fn().mockResolvedValue(job)
    };
    api.renderTeamLanding.mockImplementation(
      (_job: TeamLandingRenderJob, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('TIMEOUT')), { once: true });
        })
    );

    render(
      <TeamProvider
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'Render team',
            role: 'editor',
            permissions: {
              view: true,
              download: true,
              upload: true,
              edit: true,
              delete: false,
              process: true,
              manage_members: false,
              manage_metadata: true
            },
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <TeamLandings teamId={TEAM_ID} client={client} />
      </TeamProvider>
    );

    expect(await screen.findByRole('button', { name: 'Create shared preview' })).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create shared preview' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.renderTeamLanding).toHaveBeenCalledWith(job, expect.any(AbortSignal));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 5_000);
    });

    expect(screen.getByRole('button', { name: 'Retry shared preview' })).toBeTruthy();
    expect(screen.queryByText('Creating preview…')).toBeNull();
  });
});
