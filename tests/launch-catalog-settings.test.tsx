// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
  expect(screen.queryByRole('slider')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stitch duration · 2 min' }));
  expect(
    screen.getByRole('slider', { name: 'Duration, minutes' }).getAttribute('aria-valuenow')
  ).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'Stitch duration · 2 min' }));
  expect(screen.queryByRole('slider')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Stitch duration · 2 min' }).getAttribute('aria-expanded')
  ).toBe('false');
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
  fireEvent.click(screen.getByRole('button', { name: 'Stitch duration · 30 min' }));
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
  expect(
    screen.getByRole('button', { name: 'Stitch duration · 30 min' }).getAttribute('aria-expanded')
  ).toBe('true');
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
