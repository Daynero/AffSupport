// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogMaterialItem,
  LandingGalleryItem,
  LandingTileState
} from '../packages/shared/src/team/index';
import { LandingGallery } from '../apps/web/src/team/landings/LandingGallery';
import { LandingViewerControls } from '../apps/web/src/team/landings/LandingViewerControls';
import { TeamLandings } from '../apps/web/src/team/landings/TeamLandings';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { DEFAULT_LANDING_VIEWER_PRESET } from '../packages/shared/src/team/index';

const TEAM_ID = '22000000-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function material(id: string, name: string): CatalogMaterialItem {
  return {
    id,
    teamId: 'team-1',
    parentFolderId: null,
    name,
    kind: 'file',
    category: 'landing',
    mimeType: 'text/html',
    fileExtension: 'html',
    classificationVersion: 1,
    classificationSource: 'inspected_landing',
    sizeBytes: 1234,
    modifiedAt: null,
    geo: null,
    language: null,
    offer: null,
    tags: [],
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    previewState: 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
  };
}

function item(id: string, name: string, tile: LandingTileState): LandingGalleryItem {
  const candidate = tile === 'candidate';
  return {
    material: {
      ...material(id, name),
      ...(candidate
        ? {
            category: 'archive' as const,
            mimeType: 'application/zip',
            fileExtension: 'zip',
            classificationSource: 'extension' as const,
            previewState: 'pending'
          }
        : {})
    },
    isCandidate: candidate,
    tile,
    canDownload: false,
    canEdit: false
  };
}

describe('team landings gallery (presentational)', () => {
  it('keeps long names inside semantic, theme-aware cards', () => {
    const styles = readFileSync(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8');
    const rule = (selector: string) =>
      styles.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'u'))?.[1] ?? '';

    expect(rule('\\.landing-tile-shell')).toContain('min-width: 0;');
    expect(rule('\\.landing-tile-shell')).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(rule('\\.landing-tile')).toContain('min-width: 0;');
    expect(rule('\\.landing-tile')).toContain('max-width: 100%;');
    expect(rule('\\.landing-tile')).toContain('background: var(--color-surface);');
    expect(rule('\\.landing-tile')).toContain('color: var(--color-text);');
    expect(rule('\\.landing-tile-name')).toContain('max-width: 100%;');
    expect(rule('\\.landing-gallery-count')).toContain('color: var(--color-text-muted);');
  });

  it('renders each landing as an openable tile and fires onOpen', () => {
    const onOpen = vi.fn();
    render(
      <LandingGallery
        items={[item('m1', 'Promo LP', 'ready')]}
        loading={false}
        error={false}
        resolveThumbnail={() => 'blob:thumb-1'}
        onOpen={onOpen}
      />
    );
    const tile = screen.getByRole('button', { name: /Open landing: Promo LP/ });
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1');
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens a landing even without a shared render thumbnail (live preview handles state)', () => {
    const onOpen = vi.fn();
    render(
      <LandingGallery
        items={[item('m2', 'No thumb LP', 'ready')]}
        loading={false}
        error={false}
        resolveThumbnail={() => null}
        onOpen={onOpen}
      />
    );
    const tile = screen.getByRole('button', { name: /Open landing: No thumb LP/ });
    // No fake thumbnail is shown, but the tile is still openable → the live preview reports state.
    expect(tile.querySelector('img')).toBeNull();
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('marks a not-yet-inspected archive as a candidate', () => {
    render(
      <LandingGallery
        items={[item('m3', 'Maybe LP.zip', 'candidate')]}
        loading={false}
        error={false}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText('Not previewed yet')).toBeTruthy();
  });

  it('offers an explicit shared-render action without hijacking tile open', () => {
    const onOpen = vi.fn();
    const onRender = vi.fn();
    const candidate = item('m4', 'Candidate LP.zip', 'candidate');
    render(
      <LandingGallery
        items={[candidate]}
        loading={false}
        error={false}
        onOpen={onOpen}
        onRender={onRender}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create shared preview' }));
    expect(onRender).toHaveBeenCalledWith(candidate);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('renders a welcoming empty state with no tiles', () => {
    render(<LandingGallery items={[]} loading={false} error={false} onOpen={vi.fn()} />);
    expect(screen.getByText(/No landings yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders an error state', () => {
    render(<LandingGallery items={[]} loading={false} error onOpen={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows the first lazy page of a 300-landing catalog within the 2s p95 budget', () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      item(`perf-${index}`, `Landing ${index + 1}`, 'ready')
    );
    const samples: number[] = [];
    let last: ReturnType<typeof render> | null = null;
    for (let run = 0; run < 20; run += 1) {
      last?.unmount();
      const startedAt = performance.now();
      const view = render(
        <LandingGallery
          items={firstPage}
          loading={false}
          error={false}
          page={1}
          pageSize={50}
          total={300}
          resolveThumbnail={entry => `https://example.test/${entry.material.id}.webp`}
          onPageChange={vi.fn()}
          onOpen={vi.fn()}
        />
      );
      samples.push(performance.now() - startedAt);
      last = view;
    }
    const ordered = [...samples].sort((left, right) => left - right);
    const at = (percentile: number) =>
      ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1)];
    const metrics = {
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: ordered.at(-1) ?? 0
    };
    console.info('team-landing-gallery-benchmark', JSON.stringify(metrics));
    expect(metrics.p95).toBeLessThan(2_000);
    expect(screen.getAllByRole('button', { name: /Open landing:/ })).toHaveLength(50);
    expect(document.querySelectorAll('img[loading="lazy"]')).toHaveLength(50);
    expect(screen.getByText('300 landings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
  });
});

describe('team landings gallery journey', () => {
  it('requests only landing/archive candidates and exposes no view-only write affordance', async () => {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    const landing = { ...material('m-team', 'Team promo'), teamId: TEAM_ID };
    const client = {
      searchCatalog: vi.fn().mockResolvedValue({
        items: [landing],
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
      listLandingRenders: vi.fn().mockResolvedValue([])
    };
    render(
      <TeamProvider
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'View-only team',
            role: 'viewer',
            permissions: {
              view: true,
              download: false,
              upload: false,
              edit: false,
              delete: false,
              process: false,
              manage_members: false,
              manage_metadata: false
            },
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <TeamLandings teamId={TEAM_ID} client={client} />
      </TeamProvider>
    );
    expect(await screen.findByText('Team promo')).toBeTruthy();
    expect(client.searchCatalog).toHaveBeenCalledWith(
      TEAM_ID,
      expect.objectContaining({
        filters: expect.objectContaining({ category: ['landing', 'archive'] })
      })
    );
    expect(screen.queryByRole('button', { name: /download|edit/iu })).toBeNull();
  });

  it('rejects a foreign-team result at the UI boundary', async () => {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    const client = {
      searchCatalog: vi.fn().mockResolvedValue({
        items: [{ ...material('foreign', 'Hidden competitor'), teamId: 'another-team' }],
        total: 1,
        activeFilters: {},
        facets: {},
        catalogFreshness: { state: 'ready' as const, lastSyncedAt: null }
      }),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      }),
      listLandingRenders: vi.fn().mockResolvedValue([])
    };
    render(
      <TeamProvider
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'Safe team',
            role: 'viewer',
            permissions: {
              view: true,
              download: false,
              upload: false,
              edit: false,
              delete: false,
              process: false,
              manage_members: false,
              manage_metadata: false
            },
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <TeamLandings teamId={TEAM_ID} client={client} />
      </TeamProvider>
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Hidden competitor')).toBeNull();
  });
});

describe('landing viewer controls', () => {
  it('changes zoom within shared bounds', () => {
    const onChange = vi.fn();
    render(<LandingViewerControls preset={DEFAULT_LANDING_VIEWER_PRESET} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Zoom \+/ }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LANDING_VIEWER_PRESET, zoom: 1.25 });
  });

  it('switches device and colour scheme presets', () => {
    const onChange = vi.fn();
    render(<LandingViewerControls preset={DEFAULT_LANDING_VIEWER_PRESET} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mobile' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LANDING_VIEWER_PRESET, device: 'mobile' });
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_LANDING_VIEWER_PRESET,
      colorScheme: 'dark'
    });
  });
});
