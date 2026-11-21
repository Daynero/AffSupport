// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CatalogVideoR2Availability } from '@video-compressor/shared';
import type { CatalogVideoR2Client } from '../apps/web/src/api/team-catalog-video-r2';
import { Collapse } from '../apps/web/src/components/ui/index';
import { CatalogVideoR2Toggle } from '../apps/web/src/team/product-catalog/CatalogVideoR2Toggle';
import { prefetchCatalogVideoR2Availability } from '../apps/web/src/team/product-catalog/useCatalogVideoR2Availability';

// next QA 2026-11-21: the launch editor's catalog shelf cut in and out, its R2 switch
// appeared a beat after the shelf, and its choice rows were not as tall as their fields.

afterEach(cleanup);

const TEAM = '50000000-0000-4000-8000-000000000611';
const available: CatalogVideoR2Availability = {
  available: true,
  canManage: true,
  contractVersion: 1
};

function r2Client(availability: CatalogVideoR2Client['availability']): CatalogVideoR2Client {
  return {
    availability,
    readState: vi.fn(),
    setPreference: vi.fn(),
    listSignals: vi.fn(async () => []),
    readUsage: vi.fn()
  } as unknown as CatalogVideoR2Client;
}

const toggle = (client: CatalogVideoR2Client) => (
  <CatalogVideoR2Toggle
    mode="create"
    teamId={TEAM}
    control="switch"
    client={client}
    checked={false}
    onChange={() => undefined}
  />
);

describe('Collapse', () => {
  it('keeps closed content mounted but out of reach, and opens it in place', () => {
    const { rerender, container } = render(
      <Collapse open={false}>
        <button type="button">inside</button>
      </Collapse>
    );
    const box = container.querySelector('.ui-collapse')!;
    expect(box.classList.contains('is-open')).toBe(false);
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', { name: 'inside' })).toBeNull();

    rerender(
      <Collapse open>
        <button type="button">inside</button>
      </Collapse>
    );
    expect(box.classList.contains('is-open')).toBe(true);
    expect(box.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('button', { name: 'inside' })).toBeTruthy();
    // Clips while it moves; lets focus rings spill once it has arrived.
    expect(box.classList.contains('is-settled')).toBe(false);
    fireEvent.transitionEnd(box);
    expect(box.classList.contains('is-settled')).toBe(true);
  });

  it('opens and closes by a disclosure transition the token check allows', () => {
    const css = readFileSync('apps/web/src/styles/components.css', 'utf8');
    const rule = css.slice(css.indexOf('.ui-collapse {'), css.indexOf('.ui-collapse.is-open'));
    expect(rule).toMatch(/grid-template-rows: 0fr/u);
    expect(rule).toMatch(/transition:[\s\S]*grid-template-rows/u);
  });
});

describe('R2 switch availability', () => {
  it('shows at once when the board asked ahead, instead of after its own read', async () => {
    let answer: (value: CatalogVideoR2Availability) => void = () => undefined;
    const availability = vi.fn(
      () =>
        new Promise<CatalogVideoR2Availability>(resolve => {
          answer = resolve;
        })
    );
    const client = r2Client(availability);
    prefetchCatalogVideoR2Availability(TEAM, client);
    prefetchCatalogVideoR2Availability(TEAM, client);
    expect(availability).toHaveBeenCalledTimes(1);
    await act(async () => answer(available));

    // The switch's own read is still in flight, yet the switch is already there.
    render(toggle(client));
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('a prefetch that lands while the switch waits shows it', async () => {
    const answers: ((value: CatalogVideoR2Availability) => void)[] = [];
    const client = r2Client(
      vi.fn(
        () =>
          new Promise<CatalogVideoR2Availability>(resolve => {
            answers.push(resolve);
          })
      )
    );
    prefetchCatalogVideoR2Availability(TEAM, client);
    render(toggle(client));
    expect(screen.queryByRole('switch')).toBeNull();
    await act(async () => answers[0]!(available));
    expect(screen.getByRole('switch')).toBeTruthy();
  });
});

describe('launch editor rows', () => {
  it('draws every choice row as tall as a field, and its hints are field help', () => {
    const launch = readFileSync('apps/web/src/styles/launch-settings.css', 'utf8');
    expect(launch).toMatch(
      /\.launch-editor-compact \.ui-segmented \{[^}]*height: var\(--control-height-md\)/u
    );
    // `field-hint` is the compressor's large hint (styles.css); a field's own hint in the
    // launch editor is the design system's field help, in caption size.
    for (const file of [
      'apps/web/src/team/launches/LaunchEditor.tsx',
      'apps/web/src/team/product-catalog/CatalogCreationVideoFields.tsx'
    ])
      expect(readFileSync(file, 'utf8')).not.toMatch(/className="field-hint/u);
  });
});
