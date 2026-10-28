// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
import { CatalogIconControls } from '../apps/web/src/team/catalog-updater/CatalogIconControls';
afterEach(cleanup);
const profile: CatalogUpdateProfile = {
  catalogId: 'catalog',
  restitch: true,
  refreshImages: false,
  refreshTexts: false,
  growProducts: false,
  randomLinkVariation: false,
  version: 1,
  updatedAt: '',
  restitchStatus: 'preparing'
};
it('fills measured preparation, reserves full green for usable readiness and resets on consumption', () => {
  const change = vi.fn();
  const props = { profile, name: 'Catalog', onChange: change };
  const view = render(<CatalogIconControls {...props} restitchProgress={42} />);
  const button = document.querySelector<HTMLButtonElement>('[data-catalog-field="restitch"]')!;
  expect(button.dataset.videoState).toBe('preparing');
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('0.42');
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  view.rerender(<CatalogIconControls {...props} restitchProgress={100} />);
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('0.99');
  view.rerender(
    <CatalogIconControls
      {...props}
      profile={{ ...profile, restitchStatus: 'ready' }}
      restitchProgress={12}
    />
  );
  expect(button.dataset.videoState).toBe('ready');
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('1');
  expect(button.getAttribute('aria-label')).toContain('Video ready for the next update');
  expect(screen.queryByRole('progressbar')).toBeNull();
  view.rerender(
    <CatalogIconControls
      {...props}
      profile={{ ...profile, restitchStatus: 'waiting' }}
      restitchProgress={100}
    />
  );
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('0');
  fireEvent.click(button);
  expect(change).toHaveBeenCalledWith('restitch', false);
});
it.each([null, NaN, Infinity])('does not invent a percentage for unknown progress %s', progress => {
  render(
    <CatalogIconControls
      profile={profile}
      name="Catalog"
      onChange={vi.fn()}
      restitchProgress={progress}
    />
  );
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
});
it('clears stale green when blocked or switched off, while preserving the video icon in read-only mode', () => {
  const props = { name: 'Catalog', onChange: vi.fn(), disabledReason: 'Read only' };
  const view = render(
    <CatalogIconControls {...props} profile={{ ...profile, restitchStatus: 'ready' }} />
  );
  const button = document.querySelector<HTMLButtonElement>('[data-catalog-field="restitch"]')!;
  expect(button.querySelector('.lucide-clapperboard')).not.toBeNull();
  fireEvent.click(button);
  expect(props.onChange).not.toHaveBeenCalled();
  view.rerender(
    <CatalogIconControls
      {...props}
      profile={{ ...profile, restitchStatus: 'blocked' }}
      restitchProgress={90}
    />
  );
  expect(button.dataset.videoState).toBe('blocked');
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('0');
  view.rerender(
    <CatalogIconControls
      {...props}
      profile={{ ...profile, restitch: false, restitchStatus: 'ready' }}
    />
  );
  expect(button.dataset.videoState).toBe('off');
  expect(button.style.getPropertyValue('--catalog-video-fill')).toBe('0');
});
