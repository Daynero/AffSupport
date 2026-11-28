// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPACE_DERIVATIVE_RECIPE_VERSION,
  SPACE_DERIVATIVE_SPRITE,
  spaceFilesUrl,
  type ThumbnailSession
} from '@video-compressor/shared';
import {
  clearSpaceStorageCaches,
  rememberSpaceBackend,
  rememberSpaceMaterials
} from '../apps/web/src/api/space-storage';
import { teamApi } from '../apps/web/src/api/team';
import {
  TileHoverFrames,
  clearTileHoverFrames
} from '../apps/web/src/team/explorer/TileHoverFrames';

/**
 * 057 T122: an R2 video's hover frames on its explorer tile (US7, research R5). The sprite the
 * uploading browser or the agent made is fetched only when the pointer first rests on the tile,
 * and moving across it shows the frame at that point of the clip; leaving puts the poster back.
 * A touch is a press, reduced motion keeps the poster, a clip without a sprite stays as it was.
 */

const TEAM = '05791380-0000-4000-8000-000000000001';
const DRIVE = '05791380-0000-4000-8000-000000000002';
const MATERIAL = '05791380-0000-4000-8000-000000000003';
const CONTENT = 'c'.repeat(64);
const FILES = 'https://files.soty.pp.ua';
const URL_ = 'https://files.soty.pp.ua/t/x/d/y/1/sprite?g=grant';

/** jsdom never decodes a picture: this one says it did, at the sprite's real shape. */
class LoadingImage {
  static outcome: 'load' | 'error' = 'load';
  static created = 0;
  naturalWidth = 5 * 320;
  naturalHeight = 2 * 180;
  decoding = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    LoadingImage.created += 1;
    queueMicrotask(() => (LoadingImage.outcome === 'load' ? this.onload?.() : this.onerror?.()));
  }
}

function reducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia;
}

function frames(url: string | null = URL_, onUnavailable = vi.fn()) {
  const view = render(
    <div style={{ width: 200 }}>
      <TileHoverFrames url={url} onUnavailable={onUnavailable} />
    </div>
  );
  const layer = view.container.querySelector<HTMLElement>('.team-explorer-tile-frames');
  if (layer)
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 150, right: 200, bottom: 150 }) as DOMRect;
  return { ...view, layer, onUnavailable };
}

const move = async (layer: HTMLElement, x: number, pointerType = 'mouse') => {
  fireEvent.pointerMove(layer, { clientX: x, pointerType });
  await Promise.resolve();
  await Promise.resolve();
  fireEvent.pointerMove(layer, { clientX: x, pointerType });
};

beforeEach(() => {
  vi.stubGlobal('Image', LoadingImage);
  LoadingImage.outcome = 'load';
  LoadingImage.created = 0;
  reducedMotion(false);
  clearTileHoverFrames();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearSpaceStorageCaches();
});

describe('TileHoverFrames', () => {
  it('fetches nothing until the pointer rests on the tile, then follows it across the clip', async () => {
    const { layer, container } = frames();
    expect(LoadingImage.created).toBe(0);
    expect(container.querySelector('.team-explorer-tile-frame')).toBeNull();

    await move(layer!, 1);
    expect(LoadingImage.created).toBe(1);
    const first = container.querySelector<HTMLElement>('.team-explorer-tile-frame')!;
    expect(first.dataset.frame).toBe('0');
    expect(first.style.getPropertyValue('--frame-x')).toBe('0');
    expect(first.style.getPropertyValue('--frame-y')).toBe('0');
    // The cell keeps the sprite's own shape: 320×180.
    expect(Number(first.style.getPropertyValue('--frame-aspect'))).toBeCloseTo(16 / 9);
    expect(first.style.backgroundSize).toBe(
      `${SPACE_DERIVATIVE_SPRITE.columns * 100}% ${Math.ceil(SPACE_DERIVATIVE_SPRITE.frames / SPACE_DERIVATIVE_SPRITE.columns) * 100}%`
    );

    await move(layer!, 199);
    const last = container.querySelector<HTMLElement>('.team-explorer-tile-frame')!;
    expect(last.dataset.frame).toBe(String(SPACE_DERIVATIVE_SPRITE.frames - 1));
    expect(last.style.getPropertyValue('--frame-x')).toBe('1');
    expect(last.style.getPropertyValue('--frame-y')).toBe('1');
    expect(
      container
        .querySelector<HTMLElement>('.team-explorer-tile-frames-bar')!
        .style.getPropertyValue('--frame-progress')
    ).toBe('1');

    await move(layer!, 100);
    expect(container.querySelector<HTMLElement>('.team-explorer-tile-frame')!.dataset.frame).toBe(
      '5'
    );
    fireEvent.pointerLeave(layer!);
    expect(container.querySelector('.team-explorer-tile-frame')).toBeNull();
    // Asked once: the sprite is one picture, kept by the browser under its address.
    await move(layer!, 50);
    expect(LoadingImage.created).toBe(1);
    // The layer is a picture, never something a screen reader stops on.
    expect(layer!.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves a touch to the press, and the poster standing when reduced motion is asked for', async () => {
    const touch = frames();
    await move(touch.layer!, 150, 'touch');
    expect(LoadingImage.created).toBe(0);
    expect(touch.container.querySelector('.team-explorer-tile-frame')).toBeNull();
    cleanup();

    reducedMotion(true);
    const still = frames();
    await move(still.layer!, 150);
    expect(LoadingImage.created).toBe(0);
    expect(still.container.querySelector('.team-explorer-tile-frame')).toBeNull();
    const css = readFileSync('apps/web/src/styles/explorer.css', 'utf8');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.team-explorer-tile-frame \{\s*animation: none;/u
    );
  });

  it('keeps the poster for a clip without a sprite and lets the tile retry once', async () => {
    LoadingImage.outcome = 'error';
    const { layer, container, onUnavailable } = frames();
    await move(layer!, 10);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.team-explorer-tile-frames')).toBeNull();
    expect(frames(null).container.querySelector('.team-explorer-tile-frames')).toBeNull();
  });
});

describe('teamApi.spriteUrl', () => {
  const session = (teamId: string) =>
    ({
      teamId,
      endpoint: FILES,
      token: 'g'.repeat(32),
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    }) as unknown as ThumbnailSession;

  it('names the sprite of an R2 video beside its tile, and nothing in a Drive space', () => {
    rememberSpaceBackend(TEAM, 'r2');
    rememberSpaceBackend(DRIVE, 'drive');
    rememberSpaceMaterials(TEAM, [{ id: MATERIAL, contentId: CONTENT, thumbnailReady: true }]);
    expect(teamApi.spriteUrl(session(TEAM), MATERIAL)).toBe(
      spaceFilesUrl({
        filesOrigin: FILES,
        teamId: TEAM,
        contentId: CONTENT,
        grant: 'g'.repeat(32),
        derivative: { recipeVersion: SPACE_DERIVATIVE_RECIPE_VERSION, variant: 'sprite' }
      })
    );
    expect(teamApi.spriteUrl(session(DRIVE), MATERIAL)).toBeNull();
    // A file whose pictures are not in yet has none either.
    rememberSpaceMaterials(TEAM, [
      { id: '05791380-0000-4000-8000-000000000004', contentId: CONTENT, thumbnailReady: false }
    ]);
    expect(teamApi.spriteUrl(session(TEAM), '05791380-0000-4000-8000-000000000004')).toBeNull();
  });
});
