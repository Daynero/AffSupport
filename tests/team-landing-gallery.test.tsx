// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogMaterialItem,
  LandingGalleryItem,
  LandingTileState
} from '../packages/shared/src/team/index';
import { LandingGallery } from '../apps/web/src/team/landings/LandingGallery';
import { LandingViewerControls } from '../apps/web/src/team/landings/LandingViewerControls';
import { DEFAULT_LANDING_VIEWER_PRESET } from '../packages/shared/src/team/index';

afterEach(cleanup);

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
  return {
    material: material(id, name),
    isCandidate: tile === 'candidate',
    tile,
    canDownload: false,
    canEdit: false
  };
}

describe('team landings gallery (presentational)', () => {
  it('renders a ready landing as an openable tile and fires onOpen', () => {
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
    expect(tile).toBeTruthy();
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1');
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a truthful state chip for a needs-agent landing and does not make it actionable', () => {
    const onOpen = vi.fn();
    render(
      <LandingGallery
        items={[item('m2', 'Needs agent LP', 'needs_agent')]}
        loading={false}
        error={false}
        resolveThumbnail={() => null}
        onOpen={onOpen}
      />
    );
    expect(screen.queryByRole('button', { name: /Open landing/ })).toBeNull();
    expect(screen.getByText('Open the Soty app to create a preview')).toBeTruthy();
  });

  it('never presents a ready tile without a fetchable thumbnail', () => {
    render(
      <LandingGallery
        items={[item('m3', 'No thumb LP', 'ready')]}
        loading={false}
        error={false}
        resolveThumbnail={() => null}
        onOpen={vi.fn()}
      />
    );
    // ready state but no thumbnail → falls back to an informational tile, not an open button.
    expect(screen.queryByRole('button', { name: /Open landing/ })).toBeNull();
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
