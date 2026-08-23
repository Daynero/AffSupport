// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogMaterialItem, RenderArtifactRef } from '../packages/shared/src/team/index';
import { LandingFullView } from '../apps/web/src/team/landings/LandingFullView';
import type { MaterialPreviewClient } from '../apps/web/src/team/preview/MaterialPreview';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const material: CatalogMaterialItem = {
  id: 'm1',
  teamId: 'team-1',
  parentFolderId: null,
  name: 'Promo LP',
  kind: 'file',
  category: 'landing',
  mimeType: 'text/html',
  fileExtension: 'html',
  classificationVersion: 1,
  classificationSource: 'inspected_landing',
  sizeBytes: 123,
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

function client(result: Awaited<ReturnType<MaterialPreviewClient['requestPreview']>>) {
  return {
    requestPreview: vi.fn().mockResolvedValue(result),
    openAgentArchive: vi.fn(),
    openAgentLanding: vi.fn(),
    closeAgentPreview: vi.fn()
  } satisfies MaterialPreviewClient;
}

describe('team landing full view', () => {
  it('opens every cached segment without calling a local agent', async () => {
    const artifact: RenderArtifactRef = {
      materialId: material.id,
      sourceVersion: '7',
      fingerprint: 'a'.repeat(64),
      preset: 'default',
      segmentCount: 2,
      artifactToken: 'segment-zero-token-with-enough-entropy',
      segmentTokens: [
        'segment-zero-token-with-enough-entropy',
        'segment-one-token-with-enough-entropy'
      ]
    };
    const artifactClient = {
      getLandingRenderArtifact: vi.fn().mockResolvedValue(artifact),
      landingRenderImageUrl: vi.fn(
        (_value: RenderArtifactRef, segment: number) => `https://example.test/render/${segment}`
      )
    };
    render(
      <LandingFullView
        teamId="team-1"
        material={material}
        artifact={artifact}
        artifactClient={artifactClient}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(document.body.querySelectorAll('.team-landing-cached img')).toHaveLength(2)
    );
    expect(artifactClient.getLandingRenderArtifact).toHaveBeenCalledWith(
      'team-1',
      material.id,
      'default'
    );
    expect(artifactClient.landingRenderImageUrl).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('persists and applies device, colour-scheme, and zoom controls', async () => {
    const previewClient = client({
      kind: 'media',
      rangeUrl: 'https://example.test/unused',
      mimeType: 'image/webp',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    render(
      <LandingFullView
        teamId="team-1"
        material={material}
        client={previewClient}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Mobile' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: /Zoom \+/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-landing-device')).toBe('mobile');
    expect(dialog.getAttribute('data-landing-scheme')).toBe('dark');
    expect(dialog.getAttribute('data-landing-zoom')).toBe('1.25');
    expect(JSON.parse(localStorage.getItem('soty.landing-viewer.v1') ?? '{}')).toEqual({
      device: 'mobile',
      colorScheme: 'dark',
      zoom: 1.25
    });
  });

  it.each([
    ['corrupt', 'damaged'],
    ['protected', 'password-protected'],
    ['too_large', 'too large'],
    ['unsupported', 'not supported']
  ] as const)('shows a typed %s state without breaking the viewer', async (reason, copy) => {
    render(
      <LandingFullView
        teamId="team-1"
        material={material}
        client={client({ kind: 'unavailable', reason, allowedActions: [] })}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText(new RegExp(copy, 'i'))).toBeTruthy());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
