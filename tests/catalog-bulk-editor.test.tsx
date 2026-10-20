// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));
import { CatalogBulkEditor } from '../apps/web/src/team/catalog-updater/CatalogBulkEditor';
const profile = (id: string): CatalogUpdateProfile => ({
  catalogId: id,
  refreshImages: true,
  refreshTexts: true,
  growProducts: false,
  randomLinkVariation: true,
  restitch: false,
  version: 1,
  updatedAt: '2026-10-18T10:00:00Z'
});
const items = ['A', 'B'].map(id => ({
  catalogId: id,
  name: `Catalog ${id}`,
  profile: profile(id),
  interval: null
}));
beforeEach(() => {
  localStorage.setItem('language', 'en');
  track.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function setDaily() {
  await userEvent.click(
    screen.getByRole('button', { name: /Frequency to save with the selected settings/ })
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Every day' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
}
describe('bulk editor partial results', () => {
  it('retains successful rows while retrying only failed rows and emits delivery after commit', async () => {
    let failedOnce = false;
    const save = vi.fn(async (id: string) => {
      if (id === 'B' && !failedOnce) {
        failedOnce = true;
        throw { code: 'DRIVE_UNAVAILABLE' };
      }
      return { ...profile(id), version: 2 };
    });
    const visibleTerminals: Array<{ event: string; text: string }> = [];
    track.mockImplementation((event: string) => {
      if (event === 'operation_failed' || event === 'operation_completed')
        visibleTerminals.push({ event, text: document.body.textContent ?? '' });
    });
    render(<CatalogBulkEditor items={items} save={save} onSaved={() => {}} />);
    await setDaily();
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved 1 catalogs');
    expect(visibleTerminals[0]?.event).toBe('operation_failed');
    expect(visibleTerminals[0]?.text).toContain('Catalog A');
    expect(visibleTerminals[0]?.text).toContain('Saved 1 catalogs');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved 2 catalogs');
    expect(save.mock.calls.map(call => call[0])).toEqual(['A', 'B', 'B']);
    const details = screen.getByText('Results for 2 catalogs').closest('details')!;
    expect(within(details).getByText(/Catalog A: Saved/)).toBeTruthy();
    expect(within(details).getByText(/Catalog B: Saved/)).toBeTruthy();
    expect(visibleTerminals.at(-1)?.event).toBe('operation_completed');
    expect(visibleTerminals.at(-1)?.text).toContain('Saved 2 catalogs');
    const starts = track.mock.calls.filter(([event]) => event === 'operation_started');
    expect(starts).toHaveLength(2);
    expect(starts[0][1].attempt_id).not.toBe(starts[1][1].attempt_id);
    expect(starts[0][1].flow_id).toBe(starts[1][1].flow_id);
    expect(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled')).toBe(
      true
    );
  });
  it('can keep mixed frequencies after choosing one and apply only the remaining field', async () => {
    const mixed = items.map((item, index) => ({
      ...item,
      interval: index === 0 ? ('1h' as const) : ('1d' as const)
    }));
    const save = vi.fn(async (id: string) => ({ ...profile(id), version: 2 }));
    render(<CatalogBulkEditor items={mixed} save={save} onSaved={() => {}} />);
    expect(screen.getByText(/Frequency · Mixed values/)).toBeTruthy();
    await setDaily();
    await userEvent.click(screen.getByRole('button', { name: 'Replace video · Off' }));
    await userEvent.click(await screen.findByRole('option', { name: 'On' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep each catalog’s setting' }));
    expect(
      screen.getByRole('button', {
        name: /Frequency to save with the selected settings: Mixed values/
      })
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledWith('A', 1, { restitch: true });
    expect(save).toHaveBeenCalledWith('B', 1, { restitch: true });
  });

  it('bounds large selections to four simultaneous writes and preserves every result', async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      catalogId: String(index),
      name: `Catalog ${index}`,
      profile: profile(String(index)),
      interval: null
    }));
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const save = vi.fn(async (id: string) => {
      active++;
      maxActive = Math.max(active, maxActive);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { ...profile(id), version: 2 };
    });
    const onPendingChange = vi.fn();
    const { unmount } = render(
      <CatalogBulkEditor
        items={many}
        save={save}
        onSaved={() => {}}
        onPendingChange={onPendingChange}
      />
    );
    await setDaily();
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(save).toHaveBeenCalledTimes(4);
    for (let batch = 0; batch < 3; batch++) {
      await act(async () => {
        releases.splice(0).forEach(release => release());
      });
    }
    await screen.findByText('Saved 11 catalogs');
    expect(maxActive).toBe(4);
    expect(save).toHaveBeenCalledTimes(11);
    expect(
      screen.getByText('Results for 11 catalogs').closest('details')!.querySelectorAll('li')
    ).toHaveLength(11);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    unmount();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('guards browser exit while draft or request is pending and releases after confirmed save', async () => {
    let resolve!: (profile: CatalogUpdateProfile) => void;
    const save = vi.fn(
      () =>
        new Promise<CatalogUpdateProfile>(done => {
          resolve = done;
        })
    );
    render(<CatalogBulkEditor items={[items[0]]} save={save} onSaved={() => {}} />);
    const event = () => new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(event())).toBe(true);
    await setDaily();
    expect(window.dispatchEvent(event())).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(window.dispatchEvent(event())).toBe(false);
    resolve({ ...profile('A'), version: 2 });
    await waitFor(() => expect(window.dispatchEvent(event())).toBe(true));
  });
});
