// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchCatalogVideoFields } from '../apps/web/src/team/launches/LaunchCatalogVideoFields';
import { launchCatalogVideoEnabled } from '../apps/web/src/team/launches/catalogVideoProtocol';
import type { LaunchCatalogConfig } from '../packages/shared/src/team/launches';
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
const catalog: LaunchCatalogConfig = {
  productCount: 3,
  restitchEnabled: true,
  finalDurationMode: 'custom',
  customFinalDurationSeconds: 120
};
it('limits N to products and retains incomplete calendar choices in the draft', () => {
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState(catalog);
    return (
      <LaunchCatalogVideoFields
        value={value}
        disabled={false}
        onChange={next => {
          change(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Example />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Video variations' }), {
    target: { value: '4' }
  });
  expect(screen.getByText('Enter 1 to 3 variations, up to the number of products.')).toBeTruthy();
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 4,
      videoPublication: { mode: 'immediate' }
    })
  );
  fireEvent.click(screen.getByRole('switch', { name: 'Schedule the video link' }));
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      videoPublication: expect.objectContaining({
        mode: 'scheduled',
        resolvedOffset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
        dueAt: expect.stringContaining('T')
      })
    })
  );
  expect(screen.queryByRole('button', { name: /Time zone/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /publication date/i }));
  expect(screen.getByRole('button', { name: /Time zone/ })).toBeTruthy();
});
it('exposes the new Launch path only for explicit beta opt-in', () => {
  vi.stubEnv('VITE_CATALOG_VIDEO_VARIANTS', 'true');
  vi.stubEnv('VITE_APP_ENVIRONMENT', 'production');
  expect(launchCatalogVideoEnabled()).toBe(false);
  vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
  expect(launchCatalogVideoEnabled()).toBe(true);
  vi.stubEnv('VITE_CATALOG_VIDEO_VARIANTS', 'false');
  expect(launchCatalogVideoEnabled()).toBe(false);
});
