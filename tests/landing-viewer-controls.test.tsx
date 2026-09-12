// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingViewerControls } from '../apps/web/src/team/landings/LandingViewerControls';
import { DEFAULT_LANDING_VIEWER_PRESET } from '../packages/shared/src/team/index';

/**
 * The landing viewer's controls, kept after 011 folded the landings gallery
 * into the explorer. Tile states are covered by tests/team-explorer-grid.test.tsx
 * and the render-item derivation by tests/team-landing-render-sharing.test.ts.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('landing viewer controls', () => {
  it('changes zoom within shared bounds', () => {
    const onChange = vi.fn();
    render(<LandingViewerControls preset={DEFAULT_LANDING_VIEWER_PRESET} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Zoom \+/ }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LANDING_VIEWER_PRESET, zoom: 1.25 });
  });

  it('switches device presets', () => {
    const onChange = vi.fn();
    render(<LandingViewerControls preset={DEFAULT_LANDING_VIEWER_PRESET} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mobile' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LANDING_VIEWER_PRESET, device: 'mobile' });
  });

  /* The light/dark pair was removed from the viewer: a landing carries its own scheme. */
  it('offers no colour-scheme toggle', () => {
    render(
      <LandingViewerControls preset={DEFAULT_LANDING_VIEWER_PRESET} onChange={() => undefined} />
    );
    expect(screen.queryByRole('radio', { name: 'Dark' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Light' })).toBeNull();
  });
});
