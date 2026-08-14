// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LandingPreviewItem, LandingPreviewState } from '../packages/shared/src/types.js';
import type { LandingViewerSource } from '../apps/web/src/landing-viewer/types.js';
import { LandingViewer } from '../apps/web/src/landing-viewer/LandingViewer.js';
import { useLandingViewer } from '../apps/web/src/landing-viewer/useLandingViewer.js';

// Mocked so the agentLandingSource smoke test can assert 1:1 client delegation. The source-agnostic
// suite below never touches it — it drives the viewer entirely through an in-memory fake source.
const client = vi.hoisted(() => ({
  request: vi.fn(),
  activate: vi.fn(),
  cancel: vi.fn(),
  clearCache: vi.fn(),
  eventUrl: vi.fn(() => 'http://127.0.0.1/events'),
  imageUrl: vi.fn(() => 'http://127.0.0.1/image'),
  open: vi.fn(),
  openExtracted: vi.fn(),
  refresh: vi.fn(),
  removeCatalog: vi.fn(),
  reveal: vi.fn(),
  select: vi.fn(),
  settings: vi.fn()
}));

vi.mock('../apps/web/src/api/client.js', () => ({
  request: client.request,
  landingGalleryActivate: client.activate,
  landingGalleryCancel: client.cancel,
  landingGalleryClearCache: client.clearCache,
  landingGalleryEventUrl: client.eventUrl,
  landingGalleryImageUrl: client.imageUrl,
  landingGalleryOpen: client.open,
  landingGalleryOpenExtracted: client.openExtracted,
  landingGalleryRefresh: client.refresh,
  landingGalleryRemoveCatalog: client.removeCatalog,
  landingGalleryReveal: client.reveal,
  landingGallerySelect: client.select,
  landingGallerySettings: client.settings
}));

const landing: LandingPreviewItem = {
  id: 'landing-a',
  name: 'Acme',
  relativePath: 'acme',
  sourceKind: 'team',
  sourceRelativePath: 'acme',
  archiveRoot: null,
  extractedAvailable: false,
  status: 'ready',
  stale: false,
  previewAvailable: true,
  previewWidth: 1440,
  previewHeight: 2200,
  renderedAt: 10,
  blockedExternalRequests: 0,
  warning: null,
  error: null
};

function memoryState(): LandingPreviewState {
  return {
    catalogs: [
      { id: 'c1', name: 'Team space', landingCount: 1, lastOpenedAt: 1, sourceAvailable: true }
    ],
    activeCatalogId: 'c1',
    activeCatalogName: 'Team space',
    landings: [landing],
    running: false,
    progress: { phase: 'completed', completed: 1, total: 1, currentLandingId: null },
    renderer: { available: true, error: null },
    settings: { device: 'desktop', colorScheme: 'light' },
    warnings: [],
    error: null,
    // Fresh so the container skips the auto re-scan and leaves `activate` for our assertion.
    updatedAt: Date.now()
  };
}

/** A viewer source with no OS access — the shape a future team/Supabase source would take. */
function fakeTeamSource(): LandingViewerSource {
  const state = memoryState();
  return {
    capabilities: {
      chooseFolder: false,
      openPaths: false,
      refresh: true,
      cancel: true,
      reveal: false,
      openExtracted: false,
      clearCache: false,
      removeCatalog: false,
      settings: true
    },
    fetchState: () => Promise.resolve(state),
    subscribe: () => () => {},
    imageUrl: (item, segment) => `mem://${item.id}/${segment}`,
    activate: () => Promise.resolve(state),
    refresh: vi.fn(() => Promise.resolve(state)),
    cancel: () => Promise.resolve(state),
    updateSettings: vi.fn(() => Promise.resolve(state))
  };
}

function Harness({ source }: { source: LandingViewerSource }) {
  const viewer = useLandingViewer({ source });
  return <LandingViewer viewer={viewer} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LandingViewer (source-agnostic)', () => {
  it('renders from an arbitrary in-memory source and resolves images through the source', async () => {
    render(<Harness source={fakeTeamSource()} />);
    const image = (await screen.findByAltText('Acme')) as HTMLImageElement;
    // The image URL comes from the source's resolver, not the agent transport.
    expect(image.getAttribute('src')).toBe('mem://landing-a/0');
  });

  it('hides controls the source cannot service (capability gating)', async () => {
    render(<Harness source={fakeTeamSource()} />);
    await screen.findByAltText('Acme');
    // reveal-in-Finder is disabled for this source → the control is absent…
    expect(screen.queryByLabelText('Show source')).toBeNull();
    // …while advertised capabilities keep their controls.
    expect(screen.getByRole('button', { name: 'Refresh folder' })).toBeTruthy();
    expect(screen.getByLabelText('View settings')).toBeTruthy();
  });

  it('routes actions back through the source', async () => {
    const source = fakeTeamSource();
    render(<Harness source={source} />);
    await screen.findByAltText('Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    expect(source.refresh).toHaveBeenCalledWith('changed', undefined);
  });
});

describe('agentLandingSource', () => {
  it('advertises full capabilities and maps every action 1:1 onto the client', async () => {
    const { agentLandingSource } =
      await import('../apps/web/src/landing-viewer/sources/agentLandingSource.js');
    const source = agentLandingSource();
    expect(source.capabilities).toEqual({
      chooseFolder: true,
      openPaths: true,
      refresh: true,
      cancel: true,
      reveal: true,
      openExtracted: true,
      clearCache: true,
      removeCatalog: true,
      settings: true
    });
    source.activate('c1');
    expect(client.activate).toHaveBeenCalledWith('c1');
    source.refresh?.('all');
    expect(client.refresh).toHaveBeenCalledWith('all');
    source.reveal?.('landing-a');
    expect(client.reveal).toHaveBeenCalledWith('landing-a');
    source.imageUrl(landing, 2);
    expect(client.imageUrl).toHaveBeenCalledWith('landing-a', 10, 2);
  });
});
