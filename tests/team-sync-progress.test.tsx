// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogSearchResponse } from '../packages/shared/src/team/index';
import { SyncProgress } from '../apps/web/src/team/SyncProgress';

type Freshness = CatalogSearchResponse['catalogFreshness'];

function freshness(overrides: Partial<Freshness>): Freshness {
  return {
    state: 'scanning',
    lastSyncedAt: null,
    discoveredCount: 0,
    foldersRemaining: null,
    lastProgressAt: null,
    ...overrides
  };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SyncProgress', () => {
  it('shows live discovery counters and reassurance while scanning', () => {
    render(
      <SyncProgress
        freshness={freshness({
          state: 'scanning',
          discoveredCount: 128,
          foldersRemaining: 7,
          lastProgressAt: new Date(Date.now() - 3000).toISOString()
        })}
      />
    );

    expect(screen.getByText('Syncing Google Drive…')).toBeTruthy();
    expect(screen.getByText('Items found: 128')).toBeTruthy();
    expect(screen.getByText('Folders left: 7')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText(/You can keep working/)).toBeTruthy();
  });

  it('renders nothing once the catalog is ready', () => {
    const { container } = render(<SyncProgress freshness={freshness({ state: 'ready' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('hides the folder count when no scan is in flight', () => {
    render(
      <SyncProgress
        freshness={freshness({ state: 'replaying', discoveredCount: 40, foldersRemaining: null })}
      />
    );
    expect(screen.getByText('Applying Drive changes…')).toBeTruthy();
    expect(screen.queryByText(/Folders left/)).toBeNull();
  });

  it('swaps reassurance for a check-the-connection hint when a scan looks stuck', () => {
    render(
      <SyncProgress
        freshness={freshness({
          state: 'scanning',
          discoveredCount: 12,
          lastProgressAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
        })}
      />
    );
    expect(screen.getByText(/Sync hasn’t advanced/)).toBeTruthy();
    expect(screen.queryByText(/You can keep working/)).toBeNull();
  });
});
