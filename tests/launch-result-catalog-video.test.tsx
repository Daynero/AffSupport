// @vitest-environment jsdom
// 047 T071: the variation/deferred-publication parts of a Launch result, which shipped to
// every build in 1.4.0 (00c82e4) while their UI was still covered only behind the beta flag.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
import { teamApi } from '../apps/web/src/api/team';
import { LaunchResult } from '../apps/web/src/team/launches/LaunchResult';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { forgetCatalogPublications } from '../apps/web/src/team/product-catalog/CatalogCreatedPublicationStatus';
import type { LaunchRevision } from '../packages/shared/src/team/launches';
import { launchPreview } from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';

const team = '47100000-0000-4000-8000-000000000001',
  catalog = '47100000-0000-4000-8000-000000000002';

const scheduled: CatalogPublicationSnapshot = {
  catalogId: catalog,
  revision: 1,
  mode: 'scheduled',
  dueAt: '2030-01-01T12:00:00Z',
  timeZone: 'UTC',
  target: { kind: 'source', materialId: catalog, sourceVersion: '1' },
  job: { id: catalog, state: 'waiting', revision: 1, writerFence: null },
  active: null,
  serverNow: Date.now(),
  providerCas: 'unsupported',
  writerMode: 'video_columns'
};

function revision(
  config: Partial<LaunchRevision['config']> = {},
  catalogPatch: Partial<NonNullable<LaunchRevision['catalog']>> = {}
): LaunchRevision {
  // The baseline names come from a plain catalog config; only the parts under test differ.
  const plain = launchConfig({ method: 'catalog' });
  const preview = launchPreview(plain, launchSources);
  if (!preview.ok) throw new Error('fixture');
  const base = { ...plain, ...config };
  return {
    id: 'revision',
    revisionNo: 1,
    kind: 'generated',
    baselineRevisionId: null,
    config: base,
    sources: launchSources,
    baseline: preview.value,
    overrides: {},
    createdAt: '2026-11-23T00:00:00Z',
    catalog: {
      id: catalog,
      materialId: catalog,
      variant: 1,
      name: 'Catalog',
      url: 'https://docs.google.com/spreadsheets/d/synthetic',
      restitchMaterialId: null,
      ...catalogPatch
    }
  };
}

const withVideoProtocol = {
  catalog: {
    productCount: 100,
    restitchEnabled: true,
    finalDurationMode: 'random-30-40',
    customFinalDurationSeconds: null,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 5,
    videoPublication: { mode: 'scheduled', dueAt: scheduled.dueAt, timeZone: 'UTC' }
  }
} as unknown as Partial<LaunchRevision['config']>;

function show(value: LaunchRevision, inSpace = true) {
  return render(
    <LaunchResult
      revision={value}
      overrides={{}}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable={false}
      disabled={false}
      teamId={inSpace ? team : undefined}
    />
  );
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(team, 'owner');
});
afterEach(() => {
  cleanup();
  forgetCatalogPublications();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('shows the deferred video-link publication under the catalog of a variation launch', async () => {
  const read = vi.spyOn(teamApi, 'readCatalogPublication').mockResolvedValue(scheduled);
  show(revision(withVideoProtocol));
  expect(await screen.findByText(/Creative-link publication is scheduled for/)).toBeTruthy();
  expect(read).toHaveBeenCalledWith(team, catalog, undefined, expect.anything());
});

it('keeps the line’s room while the publication is still being read', async () => {
  vi.spyOn(teamApi, 'readCatalogPublication').mockImplementation(() => new Promise(() => {}));
  const { container } = show(revision(withVideoProtocol));
  const line = container.querySelector('.catalog-publication-line');
  expect(line?.getAttribute('aria-busy')).toBe('true');
  await waitFor(() => expect(teamApi.readCatalogPublication).toHaveBeenCalled());
});

it('reads no publication for a pre-047 catalog, a deleted catalog or a result outside a space', async () => {
  const read = vi.spyOn(teamApi, 'readCatalogPublication').mockResolvedValue(scheduled);
  show(revision());
  cleanup();
  show(revision(withVideoProtocol, { available: false }));
  expect(screen.getByText(/deleted/i)).toBeTruthy();
  cleanup();
  show(revision(withVideoProtocol), false);
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  expect(document.querySelector('.catalog-publication-line')).toBeNull();
});

it('says the creatives of a multi-creative launch in words and shows each one', () => {
  // Owner, 2026-11-25: «Зображення: 10 × 10 · 11 × 10 · …» read as a riddle.
  const creatives = [
    { materialId: 'a', alias: 'Lp33', copies: 60, pinned: null },
    { materialId: 'b', alias: 'Qa47', copies: 40, pinned: 1 }
  ];
  show(revision({ creatives, creativeKind: 'video' }), false);
  const shares = screen.getByRole('region', { name: 'Creatives' });
  expect(shares.textContent).toContain('2 creatives · 100 products');
  expect(shares.textContent).not.toContain('×');
  // Shares differ, so each thumbnail carries its own count.
  expect(screen.getByLabelText('60 products').textContent).toBe('60');
  expect(screen.getByLabelText('40 products').textContent).toBe('40');
  expect(screen.getByText('Lp33')).toBeTruthy();
  cleanup();
  const even = Array.from({ length: 12 }, (_, i) => ({
    materialId: `m${i}`,
    alias: `c${i + 1}`,
    copies: 10,
    pinned: null
  }));
  show(revision({ creatives: even, creativeKind: 'image' }), false);
  const region = screen.getByRole('region', { name: 'Creatives' });
  expect(region.textContent).toContain('12 creatives · 10 products each');
  expect(screen.queryByLabelText('10 products')).toBeNull();
  // The first eight, then «+4» opens the rest.
  expect(
    region.querySelectorAll('li.launch-result-creative .launch-creative-thumbnail')
  ).toHaveLength(8);
  fireEvent.click(screen.getByRole('button', { name: '+4' }));
  expect(
    region.querySelectorAll('li.launch-result-creative .launch-creative-thumbnail')
  ).toHaveLength(12);
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true'
  );
  cleanup();
  show(revision({ creatives: creatives.slice(0, 1) }), false);
  expect(screen.queryByRole('region', { name: 'Creatives' })).toBeNull();
});

it('titles the result with the name typed for several creatives', () => {
  const creatives = [
    { materialId: 'a', alias: 'Lp33', copies: 2, pinned: null },
    { materialId: 'b', alias: 'Qa47', copies: 2, pinned: null }
  ];
  show(revision({ creatives, creativeKind: 'video', creativeLabel: 'pak_1' }), false);
  expect(document.querySelector('.launch-result-card')?.textContent).toContain('/ pak_1');
  cleanup();
  show(revision({ creatives, creativeKind: 'video' }), false);
  expect(document.querySelector('.launch-result-card')?.textContent).toMatch(/\/ \S+\+1/u);
});
