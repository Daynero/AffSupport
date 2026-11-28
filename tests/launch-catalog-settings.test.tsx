// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseLaunchCatalogVideoConfig } from '@video-compressor/shared';
import { LaunchEditor } from '../apps/web/src/team/launches/LaunchEditor';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';
vi.mock('../apps/web/src/team/launches/LaunchCreativePicker', () => ({
  LaunchCreativePicker: () => null
}));
afterEach(cleanup);
it('shows restitch duration only after video restitching is enabled', () => {
  const draft = newLaunchDraft();
  const change = vi.fn();
  const props = {
    teamId: 'team',
    sources: null,
    accounts: [],
    offers: [],
    buyers: [],
    onChange: change,
    disabled: false,
    onRefreshSources: vi.fn()
  };
  draft.method = 'catalog';
  draft.catalog!.finalDurationMode = 'custom';
  draft.catalog!.customFinalDurationSeconds = 120;
  const view = render(<LaunchEditor {...props} config={draft} />);
  expect(screen.queryByRole('slider', { name: 'Duration, minutes' })).toBeNull();
  view.rerender(
    <LaunchEditor
      {...props}
      config={{ ...draft, catalog: { ...draft.catalog!, restitchEnabled: true } }}
    />
  );
  // Open beside the switches as soon as re-stitch is on (next QA 2026-11-21).
  expect(screen.getByText('Stitch duration · 2 min')).toBeTruthy();
  expect(
    screen.getByRole('slider', { name: 'Duration, minutes' }).getAttribute('aria-valuenow')
  ).toBe('2');
});
it('initializes missing catalog settings when an older draft changes launch method', () => {
  const change = vi.fn();
  render(
    <LaunchEditor
      teamId="team"
      config={{ ...newLaunchDraft(), catalog: undefined }}
      sources={null}
      accounts={[]}
      offers={[]}
      buyers={[]}
      onChange={change}
      disabled={false}
      onRefreshSources={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }));
  expect(change).toHaveBeenCalledWith({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  });
});

it('keeps invalid catalog controls neutral until validation and excludes hidden duration settings', () => {
  const draft = newLaunchDraft();
  draft.method = 'catalog';
  draft.catalog = {
    ...draft.catalog!,
    productCount: 0,
    restitchEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: null
  };
  const props = {
    teamId: 'team',
    sources: null,
    accounts: [],
    offers: [],
    buyers: [],
    onChange: vi.fn(),
    disabled: false,
    onRefreshSources: vi.fn()
  };
  const view = render(<LaunchEditor {...props} config={draft} />);
  const count = screen.getByRole('spinbutton', { name: 'Products in catalog' });
  const duration = screen.getByRole('slider', { name: 'Duration, minutes' });
  expect(count.closest('.bg-warning-soft')).toBeNull();
  expect(
    duration.closest('.restitch-duration-control')?.classList.contains('bg-warning-soft')
  ).toBe(false);
  view.rerender(
    <LaunchEditor
      {...props}
      config={{
        ...draft,
        catalog: { ...draft.catalog, productCount: 100, customFinalDurationSeconds: 120 }
      }}
    />
  );
  expect(count.closest('.bg-warning-soft')).toBeNull();
  expect(
    duration.closest('.restitch-duration-control')?.classList.contains('bg-warning-soft')
  ).toBe(false);
  view.rerender(<LaunchEditor {...props} config={{ ...draft, method: 'other' }} />);
  expect(screen.queryByRole('spinbutton', { name: 'Products in catalog' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Duration, minutes' })).toBeNull();
});

it('reveals the duration editor automatically when its hidden value is invalid on submit', () => {
  const draft = newLaunchDraft();
  draft.method = 'catalog';
  draft.catalog = {
    ...draft.catalog!,
    restitchEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: null
  };
  render(
    <LaunchEditor
      teamId="team"
      config={draft}
      sources={null}
      accounts={[]}
      offers={[]}
      buyers={[]}
      onChange={vi.fn()}
      disabled={false}
      submitted
      onRefreshSources={vi.fn()}
    />
  );
  expect(screen.getByText('Stitch duration · 30 min')).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Duration, minutes' })).toBeTruthy();
});

/**
 * Found on next 2026-11-21: turning restitch on in a launch with three videos set one
 * variation and showed «at least 3 — one per video» at once, an error the user had not made.
 */
const threeVideos = () => ({
  ...newLaunchDraft(),
  method: 'catalog' as const,
  creativeKind: 'video' as const,
  materialId: 'video-a',
  creativeAlias: 'A',
  creatives: ['a', 'b', 'c'].map(id => ({
    materialId: `video-${id}`,
    alias: id.toUpperCase(),
    copies: id === 'a' ? 34 : 33,
    pinned: null
  }))
});
const editorProps = (change: ReturnType<typeof vi.fn>) => ({
  teamId: 'team',
  sources: null,
  accounts: [],
  offers: [],
  buyers: [],
  onChange: change,
  disabled: false,
  onRefreshSources: vi.fn()
});

it('starts restitch at one variation per video when a launch has several', () => {
  const change = vi.fn();
  render(<LaunchEditor {...editorProps(change)} config={threeVideos()} />);
  fireEvent.click(screen.getByRole('switch', { name: 'Restitch video' }));
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      catalog: expect.objectContaining({ restitchEnabled: true, videoVariationCount: 3 })
    })
  );
  // A draft saved with a bare count could never be opened again (next, 2026-11-21).
  const catalog = change.mock.lastCall![0].catalog;
  expect(catalog.catalogVideoProtocolVersion).toBe(1);
  expect(parseLaunchCatalogVideoConfig(catalog, true)).not.toBeNull();
});

it('keeps a variation count that already covers every video when restitch is turned on', () => {
  const change = vi.fn();
  const draft = threeVideos();
  draft.catalog = { ...draft.catalog!, videoVariationCount: 12 };
  render(<LaunchEditor {...editorProps(change)} config={draft} />);
  fireEvent.click(screen.getByRole('switch', { name: 'Restitch video' }));
  expect(change.mock.lastCall![0].catalog.videoVariationCount).toBe(12);
});

/** Found on next 2026-11-21: an image launch offered to «schedule the video link». */
it('offers to schedule the images, not a video link, in a launch of images', async () => {
  const images = {
    ...threeVideos(),
    creativeKind: 'image' as const,
    creatives: threeVideos().creatives!.map(c => ({
      ...c,
      materialId: c.materialId.replace('video', 'image')
    }))
  };
  render(<LaunchEditor {...editorProps(vi.fn())} config={images} />);
  expect(await screen.findByRole('switch', { name: 'Schedule the images' })).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Schedule the video link' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Restitch video' })).toBeNull();
});

/** Found on next 2026-11-21: the split ran on into the field's name inside its label. */
it('says how variations go round the videos under the field, apart from its name', async () => {
  const draft = threeVideos();
  draft.catalog = {
    ...draft.catalog!,
    restitchEnabled: true,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 4
  };
  render(<LaunchEditor {...editorProps(vi.fn())} config={draft} />);
  const field = await screen.findByRole('textbox', { name: 'Video variations' });
  expect(field.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe(
    'Variations go to videos in turn: 2 · 1 · 1'
  );
});
it('keeps the re-stitch switch in place: its variations join its row, its duration folds below', async () => {
  // next QA 2026-11-21: turning re-stitch on added a labelled field above the row and
  // dropped the switch a line down, out from under the pointer.
  const draft = threeVideos();
  const view = render(<LaunchEditor {...editorProps(vi.fn())} config={draft} />);
  const restitch = screen.getByRole('switch', { name: 'Restitch video' });
  const row = restitch.closest('.launch-editor-catalog-row');
  expect(row).toBeTruthy();
  const fold = document.querySelector('.launch-editor-catalog-fold');
  expect(fold?.classList.contains('is-open')).toBe(false);
  view.rerender(
    <LaunchEditor
      {...editorProps(vi.fn())}
      config={{
        ...draft,
        catalog: {
          ...draft.catalog!,
          restitchEnabled: true,
          catalogVideoProtocolVersion: 1,
          videoVariationCount: 3
        }
      }}
    />
  );
  const variations = await screen.findByRole('textbox', { name: 'Video variations' });
  expect(variations.closest('.launch-editor-catalog-row')).toBe(row);
  expect(
    screen.getByRole('switch', { name: 'Restitch video' }).closest('.launch-editor-catalog-row')
  ).toBe(row);
  expect(document.querySelector('.launch-editor-catalog-fold')).toBe(fold);
  expect(fold?.classList.contains('is-open')).toBe(true);
});
it('lands every press of «Generate» on the first visible error, focuses and flashes it (next QA 2026-11-21)', async () => {
  const scrolled: Element[] = [];
  // jsdom has no scrollIntoView; the editor calls it optionally, so give it one to watch.
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    // «Без каталогу» keeps the folded catalog settings: an error in them (999 variations)
    // must not be the target, however early it stands in the form.
    const base = newLaunchDraft();
    const draft = {
      ...base,
      method: 'other' as const,
      campaignCount: 0,
      catalog: {
        ...base.catalog!,
        restitchEnabled: true,
        catalogVideoProtocolVersion: 1 as const,
        videoVariationCount: 999,
        videoPublication: { mode: 'immediate' as const }
      }
    };
    const view = render(
      <LaunchEditor {...editorProps(vi.fn())} config={draft} submitted submitAttempt={1} />
    );
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    const errors = [...document.querySelectorAll('.ui-field-error')];
    expect(errors.some(error => error.closest('[inert]'))).toBe(true);
    const visible = errors.find(
      error => !error.closest('[hidden], [inert], [aria-hidden="true"]')
    )!;
    const field = visible.closest<HTMLElement>('.ui-field')!;
    expect(scrolled).toEqual([field]);
    expect(field.classList.contains('is-invalid')).toBe(true);
    expect(field.contains(document.activeElement)).toBe(true);
    expect(field.classList.contains('is-attention')).toBe(true);
    // The second press finds it again.
    view.rerender(
      <LaunchEditor {...editorProps(vi.fn())} config={draft} submitted submitAttempt={2} />
    );
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    expect(scrolled).toEqual([field, field]);
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

it('offers an R2 space only what its Launch catalog can make there (057 T104)', async () => {
  const { rememberSpaceBackend } = await import('../apps/web/src/api/space-storage');
  rememberSpaceBackend('r2-team', 'r2');
  const draft = newLaunchDraft();
  draft.method = 'catalog';
  const props = {
    sources: null,
    accounts: [],
    offers: [],
    buyers: [],
    onChange: vi.fn(),
    disabled: false,
    onRefreshSources: vi.fn()
  };
  const several = {
    ...draft,
    materialId: '05791070-0000-4000-8000-000000000001',
    creativeKind: 'video' as const,
    creatives: [
      { materialId: '05791070-0000-4000-8000-000000000001', alias: 'a', copies: 50, pinned: null },
      { materialId: '05791070-0000-4000-8000-000000000002', alias: 'b', copies: 50, pinned: null }
    ]
  };
  const view = render(<LaunchEditor {...props} teamId="r2-team" config={draft} />);
  // Re-stitching has no R2 path yet, and the copy is no option: a space's catalog is always R2.
  expect(screen.queryByRole('switch', { name: 'Restitch video' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Copy the video to R2' })).toBeNull();
  expect(view.container.querySelector('.launch-editor-catalog-publication')).not.toBeNull();
  view.rerender(<LaunchEditor {...props} teamId="r2-team" config={several} />);
  // A later link for several videos needs a target per video: not offered there yet.
  expect(view.container.querySelector('.launch-editor-catalog-publication')).toBeNull();
  view.rerender(
    <LaunchEditor
      {...props}
      teamId="r2-team"
      config={{ ...draft, catalog: { ...draft.catalog!, restitchEnabled: true } }}
    />
  );
  // A choice already made stays visible, so it can be undone.
  expect(screen.getByRole('switch', { name: 'Restitch video' })).toBeTruthy();
  view.rerender(<LaunchEditor {...props} teamId="drive-team" config={several} />);
  expect(screen.getByRole('switch', { name: 'Restitch video' })).toBeTruthy();
  expect(view.container.querySelector('.launch-editor-catalog-publication')).not.toBeNull();
});
