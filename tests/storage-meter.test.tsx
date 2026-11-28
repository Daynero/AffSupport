// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageMeter,
  type StorageMeterProps,
  type StorageMeterSegment
} from '../apps/web/src/components/ui/index';

/**
 * 057 T054: the storage scale (FR-046, US9.1–US9.2). A segment is never told from its neighbour
 * by colour alone — it has its name and size in the legend, a gap of the track and a hint with
 * name, size and share. The legend is the keyboard's and the thumb's way in; the reservation is
 * hatched; the phone gets the compact form; both themes are tokens.
 */

afterEach(cleanup);

const GB = 1_000_000_000;
const segments: StorageMeterSegment[] = [
  { category: 'materials', label: 'Materials', bytes: 2 * GB },
  { category: 'catalogs', label: 'Catalogs', bytes: 5 * GB },
  { category: 'process', label: 'Processing results', bytes: 0 },
  { category: 'attachments', label: 'Task attachments', bytes: 1 * GB },
  { category: 'versions', label: 'Previous versions', bytes: 0 },
  { category: 'trash', label: 'Trash', bytes: 0.5 * GB }
];

function meter(overrides: Partial<StorageMeterProps> = {}) {
  return render(
    <StorageMeter
      segments={segments}
      reservedBytes={1 * GB}
      capacityBytes={10 * GB}
      formatBytes={bytes => `${bytes / GB} GB`}
      formatShare={share => `${Math.round(share * 100)} %`}
      labels={{
        name: 'Space storage',
        summary: 'Used 8.5 GB of 10 GB',
        reserved: 'Being written',
        free: 'Free'
      }}
      {...overrides}
    />
  );
}

describe('StorageMeter', () => {
  it('names and sizes every segment in words, not by colour alone', () => {
    const { container } = meter({ onSelect: () => {} });
    const bar = container.querySelector('.ui-storage-meter-track')!;
    // Only what holds bytes is drawn, in the ledger's order, each with its hint.
    expect(
      Array.from(bar.querySelectorAll('.ui-storage-meter-segment')).map(node =>
        node.getAttribute('data-category')
      )
    ).toEqual(['materials', 'catalogs', 'attachments', 'trash', 'reserved']);
    expect(bar.querySelector('[data-category="catalogs"]')!.getAttribute('title')).toBe(
      'Catalogs · 5 GB · 50 %'
    );
    // Each segment is as wide as its share of the capacity.
    expect(
      (bar.querySelector('[data-category="catalogs"]') as HTMLElement).style.getPropertyValue(
        '--storage-share'
      )
    ).toBe('0.5');
    // The legend says the same in words: a swatch, a name, a size.
    for (const name of [
      'Materials',
      'Catalogs',
      'Task attachments',
      'Trash',
      'Being written',
      'Free'
    ])
      expect(screen.getByText(name)).toBeTruthy();
    // Free is what neither the categories nor the reservation hold: 10 − 8.5 − 1.
    expect(screen.getAllByText('0.5 GB')).toHaveLength(2);
    // The bar is a picture of the legend; screen readers read the meter and the legend.
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    const value = screen.getByRole('meter', { name: 'Space storage' });
    expect(value.getAttribute('aria-valuenow')).toBe('95');
    expect(value.getAttribute('aria-valuetext')).toBe('Used 8.5 GB of 10 GB');
  });

  it('walks the legend with the arrows from one tab stop, and opens a category with Enter', () => {
    const onSelect = vi.fn();
    meter({ onSelect });
    const materials = screen.getByRole('button', { name: 'Materials · 2 GB · 20 %' });
    const catalogs = screen.getByRole('button', { name: 'Catalogs · 5 GB · 50 %' });
    const trash = screen.getByRole('button', { name: 'Trash · 0.5 GB · 5 %' });
    // One tab stop; reserved and free are said but not chosen.
    expect(materials.tabIndex).toBe(0);
    expect(catalogs.tabIndex).toBe(-1);
    expect(screen.queryByRole('button', { name: /Being written/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Free/u })).toBeNull();
    materials.focus();
    fireEvent.keyDown(materials, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(catalogs);
    expect(catalogs.tabIndex).toBe(0);
    fireEvent.keyDown(catalogs, { key: 'End' });
    expect(document.activeElement).toBe(trash);
    fireEvent.keyDown(trash, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(materials);
    fireEvent.click(catalogs);
    expect(onSelect).toHaveBeenCalledWith('catalogs');
    // A press on the bar's segment opens the same category.
    const segment = document.querySelector('.ui-storage-meter-track [data-category="trash"]')!;
    fireEvent.click(segment);
    expect(onSelect).toHaveBeenLastCalledWith('trash');
  });

  it('marks the open category and stays display-only without a handler', () => {
    meter({ onSelect: () => {}, selected: 'catalogs' });
    expect(
      screen.getByRole('button', { name: 'Catalogs · 5 GB · 50 %' }).getAttribute('aria-pressed')
    ).toBe('true');
    cleanup();
    meter();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('hatches the bytes being written, apart from every category', () => {
    const { container } = meter();
    expect(container.querySelector('.ui-storage-meter-segment.is-reserved')).toBeTruthy();
    expect(container.querySelector('.ui-storage-meter-swatch.is-reserved')).toBeTruthy();
    cleanup();
    const { container: none } = meter({ reservedBytes: 0 });
    expect(none.querySelector('.is-reserved')).toBeNull();
  });

  it('says how full the space is with a word and a sign, not only a colour', () => {
    const { container } = meter({
      level: 'critical',
      labels: {
        name: 'Space storage',
        summary: 'Used 9.6 GB of 10 GB',
        reserved: 'Being written',
        free: 'Free',
        level: 'Space is running out'
      }
    });
    expect(container.querySelector('.ui-storage-meter')!.getAttribute('data-level')).toBe(
      'critical'
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Space is running out');
    expect(status.querySelector('svg')).toBeTruthy();
  });

  it('has a compact form for the phone', () => {
    const { container } = meter({ compact: true, onSelect: () => {} });
    expect(container.querySelector('.ui-storage-meter')!.className).toContain('is-compact');
    const css = readFileSync('apps/web/src/styles/storage-meter.css', 'utf8');
    expect(css).toMatch(/\.ui-storage-meter\.is-compact \.ui-storage-meter-legend \{[^}]*grid/u);
  });

  it('draws every category from a token both themes define', () => {
    const tokens = readFileSync('apps/web/src/styles/tokens.css', 'utf8');
    const css = readFileSync('apps/web/src/styles/storage-meter.css', 'utf8');
    const light = tokens.slice(0, tokens.indexOf(":root[data-theme='dark']"));
    const dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']"));
    for (const name of [
      'materials',
      'catalogs',
      'process',
      'attachments',
      'versions',
      'trash',
      'reserved'
    ]) {
      expect(light).toMatch(new RegExp(`--color-storage-${name}: #[0-9a-f]{6};`, 'u'));
      expect(dark).toMatch(new RegExp(`--color-storage-${name}: #[0-9a-f]{6};`, 'u'));
      expect(css).toContain(`var(--color-storage-${name})`);
    }
    // The two themes do not share a value: each is lifted for its own canvas.
    const value = (block: string, name: string) =>
      new RegExp(`--color-storage-${name}: (#[0-9a-f]{6});`, 'u').exec(block)?.[1];
    expect(value(light, 'catalogs')).not.toBe(value(dark, 'catalogs'));
    // No literal colour in the component's sheet.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
    // Neighbours are separated by the track, not by colour alone.
    expect(css).toMatch(/\.ui-storage-meter-track \{[^}]*gap:/u);
  });
});
