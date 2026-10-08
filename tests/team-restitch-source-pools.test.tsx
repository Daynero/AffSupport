// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestitchPoolSummary, RestitchSource } from '@video-compressor/shared';

/**
 * Feature 030: one slot's pool as the panel shows it. What is worth proving is that every
 * source says what it is worth and what happened to it, that removing one writes references
 * and nothing else, and that the pickers are the space's own and only appear when there is a
 * catalog to browse.
 */

const { ToastProvider } = await import('../apps/web/src/components/toast');
const { RestitchSourcePool } = await import('../apps/web/src/team/workspace/RestitchSourcePool');

const TEAM_ID = '30000000-0000-4000-8000-0000000000bb';

function source(overrides: Partial<RestitchSource> = {}): RestitchSource {
  return {
    materialId: 'm-folder',
    driveFileId: null,
    kind: 'folder',
    name: 'Finals',
    availability: 'available',
    imageCount: 4,
    skipped: { format: 1, size: 0, animated: 1 },
    ...overrides
  };
}

function pool(overrides: Partial<RestitchPoolSummary> = {}): RestitchPoolSummary {
  return { state: 'ready', overLimit: false, eligibleCount: 4, sources: [source()], ...overrides };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPool(props: Partial<Parameters<typeof RestitchSourcePool>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <ToastProvider>
      <RestitchSourcePool
        teamId={TEAM_ID}
        slot="start"
        pool={pool()}
        editable
        client={{ listMaterials: vi.fn().mockResolvedValue([]) }}
        onChange={onChange}
        {...props}
      />
    </ToastProvider>
  );
  return onChange;
}

describe('a slot’s pool', () => {
  it('says how many pictures it gives and why the rest were skipped', () => {
    renderPool();
    expect(screen.getByRole('status').textContent).toContain('4 pictures ready to draw from');
    expect(screen.getByRole('status').textContent).toContain('2 files skipped.');
    expect(screen.getByText('Finals')).toBeTruthy();
    expect(screen.getByText(/4 images/).textContent).toContain(
      '1 by format, 0 by size, 1 animated'
    );
  });

  it('names each unavailable source by what happened to it', () => {
    renderPool({
      pool: pool({
        state: 'partial',
        eligibleCount: 1,
        sources: [
          source({ materialId: 'a', kind: 'file', name: 'a.png', imageCount: 1 }),
          source({
            materialId: 'b',
            kind: 'file',
            name: 'b.png',
            availability: 'trashed',
            imageCount: 0
          }),
          source({ materialId: 'c', name: 'Moved', availability: 'out_of_root', imageCount: 0 }),
          source({
            materialId: null,
            driveFileId: 'd',
            name: 'd',
            availability: 'pending',
            imageCount: 0
          }),
          source({
            materialId: 'e',
            kind: 'file',
            name: 'e.heic',
            availability: 'unsupported',
            imageCount: 0
          })
        ]
      })
    });
    expect(screen.getByText('In the bin')).toBeTruthy();
    expect(screen.getByText('Outside the connected folder')).toBeTruthy();
    expect(screen.getByText('Waiting for the catalog')).toBeTruthy();
    expect(screen.getByText('Not a picture the app can stitch')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('4 sources are unavailable.');
  });

  it('says the slot is off when nothing is chosen, and warns past the limit', () => {
    renderPool({ pool: pool({ state: 'empty', eligibleCount: 0, sources: [] }) });
    expect(screen.getByRole('status').textContent).toContain('this slot is off');
    cleanup();
    renderPool({ pool: pool({ overLimit: true, eligibleCount: 500 }) });
    expect(screen.getByRole('status').textContent).toContain(
      'Only the first 500 pictures are used.'
    );
  });

  it('marks overlapping sources once', () => {
    renderPool({
      pool: pool({
        eligibleCount: 4,
        sources: [
          source(),
          source({ materialId: 'inside', kind: 'file', name: 'inside.png', imageCount: 1 })
        ]
      })
    });
    expect(screen.getByRole('status').textContent).toContain('Overlapping sources count once.');
  });

  it('removes a source by writing the remaining references', async () => {
    const onChange = renderPool({
      pool: pool({
        sources: [
          source(),
          source({
            materialId: null,
            driveFileId: 'pending-folder',
            name: 'Soon',
            availability: 'pending'
          })
        ]
      })
    });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Remove Finals from the pictures' }));
    expect(onChange).toHaveBeenCalledWith('start', [
      { driveFileId: 'pending-folder', kind: 'folder' }
    ]);
  });

  it('offers the space’s pickers only when editable and browsable', () => {
    renderPool();
    expect(screen.getByRole('button', { name: 'Add pictures' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a folder' })).toBeTruthy();
    cleanup();
    renderPool({ editable: false });
    expect(screen.queryByRole('button', { name: 'Add pictures' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    cleanup();
    renderPool({ client: undefined });
    expect(screen.queryByRole('button', { name: 'Add a folder' })).toBeNull();
  });
});
