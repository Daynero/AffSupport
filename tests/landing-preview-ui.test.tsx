// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LandingPreviewState } from '../packages/shared/src/types.js';

const api = vi.hoisted(() => ({
  request: vi.fn(),
  activate: vi.fn(),
  cancel: vi.fn(),
  clearCache: vi.fn(),
  open: vi.fn(),
  openExtracted: vi.fn(),
  refresh: vi.fn(),
  reveal: vi.fn(),
  removeCatalog: vi.fn(),
  resolveDrop: vi.fn(),
  select: vi.fn(),
  settings: vi.fn()
}));

vi.mock('../apps/web/src/api/client.js', () => ({
  request: api.request,
  landingGalleryActivate: api.activate,
  landingGalleryCancel: api.cancel,
  landingGalleryClearCache: api.clearCache,
  toolEventUrl: () => 'http://127.0.0.1/events',
  landingGalleryImageUrl: (id: string, revision: number | null, segment = 0) =>
    `http://127.0.0.1/preview/${id}?v=${revision ?? 0}&segment=${segment}`,
  landingGalleryOpen: api.open,
  landingGalleryOpenExtracted: api.openExtracted,
  landingGalleryRefresh: api.refresh,
  landingGalleryRemoveCatalog: api.removeCatalog,
  landingGalleryResolveDrop: api.resolveDrop,
  landingGalleryReveal: api.reveal,
  landingGallerySelect: api.select,
  landingGallerySettings: api.settings
}));

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import LandingPreviewPage from '../apps/web/src/landing-preview/LandingPreviewPage.js';

const galleryState: LandingPreviewState = {
  catalogs: [
    {
      id: 'catalog-1',
      name: 'Affiliate landings',
      landingCount: 2,
      lastOpenedAt: 1,
      sourceAvailable: true
    }
  ],
  activeCatalogId: 'catalog-1',
  activeCatalogName: 'Affiliate landings',
  landings: [
    {
      id: 'landing-a',
      name: 'Acme',
      relativePath: 'clients/acme',
      sourceKind: 'folder',
      sourceRelativePath: 'clients/acme',
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
    },
    {
      id: 'landing-b',
      name: 'Summer offer',
      relativePath: 'offers.zip/bundle/summer',
      sourceKind: 'zip',
      sourceRelativePath: 'offers.zip',
      archiveRoot: 'bundle/summer',
      extractedAvailable: true,
      status: 'ready',
      stale: false,
      previewAvailable: true,
      previewWidth: 1440,
      previewHeight: 1800,
      previewSegments: 3,
      renderedAt: 20,
      blockedExternalRequests: 0,
      warning: null,
      error: null
    }
  ],
  running: false,
  progress: { phase: 'completed', completed: 2, total: 2, currentLandingId: null },
  renderer: { available: true, error: null },
  settings: { device: 'desktop', colorScheme: 'light' },
  warnings: [],
  error: null,
  updatedAt: 20
};

class EventSourceStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('language', 'en');
  vi.stubGlobal('EventSource', EventSourceStub);
  api.request.mockResolvedValue(galleryState);
  for (const action of [
    api.activate,
    api.cancel,
    api.clearCache,
    api.open,
    api.openExtracted,
    api.refresh,
    api.removeCatalog,
    api.reveal,
    api.select,
    api.settings
  ]) {
    action.mockResolvedValue(galleryState);
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('landing preview viewer', () => {
  it('renders the folder tree and switches screenshots with navigation controls', async () => {
    render(<LandingPreviewPage />);

    expect(await screen.findByRole('img', { name: 'Acme' })).toBeTruthy();
    expect(api.activate).toHaveBeenCalledWith('catalog-1');
    expect(screen.getByRole('treeitem', { name: /clients/iu })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: /offers\.zip/iu })).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: 'Next landing' })[0]);
    expect(await screen.findByRole('img', { name: 'Summer offer' })).toBeTruthy();
    expect(document.querySelectorAll('.landing-gallery-image-stack img')).toHaveLength(3);
    const extracted = screen.getByRole('button', { name: 'Open extracted copy' });
    expect((extracted as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(extracted);
    expect(api.openExtracted).toHaveBeenCalledWith('landing-b');
  });

  it('keeps zoom and fit preferences while switching landings and reopening the viewer', async () => {
    const first = render(<LandingPreviewPage />);
    expect(await screen.findByRole('img', { name: 'Acme' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('90%')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Next landing' })[0]);
    expect(await screen.findByRole('img', { name: 'Summer offer' })).toBeTruthy();
    expect(screen.getByText('90%')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Fit page' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Previous landing' })[0]);
    expect(screen.getByRole('button', { name: 'Fit page' }).getAttribute('aria-pressed')).toBe(
      'true'
    );

    first.unmount();
    render(<LandingPreviewPage />);
    expect(await screen.findByRole('img', { name: 'Acme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fit page' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('labels icon controls with delayed custom hints instead of native titles', async () => {
    render(<LandingPreviewPage />);
    expect(await screen.findByRole('img', { name: 'Acme' })).toBeTruthy();

    const back = screen.getByRole('button', { name: 'Back to tools' });
    expect(back.getAttribute('data-tooltip')).toBe('Back to tools');
    expect(back.getAttribute('title')).toBe('');

    const actualSize = screen.getByRole('button', { name: 'Actual size' });
    expect(actualSize.getAttribute('data-tooltip')).toBe('Actual size');

    const css = readFileSync('apps/web/src/styles.css', 'utf8');
    expect(css).toMatch(
      /\.landing-gallery-delayed-tooltip::after\s*{[\s\S]*?transition:[\s\S]*?1s/
    );
    expect(css).toContain('.landing-gallery-delayed-tooltip:hover:not(:focus)::after');
    expect(css).toContain('.landing-gallery-delayed-tooltip:active::after');
  });
});
