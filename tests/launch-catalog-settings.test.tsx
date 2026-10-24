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
  expect(
    screen.getByRole('slider', { name: 'Duration, minutes' }).getAttribute('aria-valuenow')
  ).toBe('2');
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
  const duration = screen.getByRole('slider', { name: 'Duration, minutes' });
  expect(count.closest('.ui-field')?.classList.contains('bg-warning-soft')).toBe(false);
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
  expect(count.closest('.ui-field')?.classList.contains('bg-warning-soft')).toBe(false);
  expect(
    duration.closest('.restitch-duration-control')?.classList.contains('bg-warning-soft')
  ).toBe(false);
  view.rerender(<LaunchEditor {...props} config={{ ...draft, method: 'other' }} />);
  expect(screen.queryByRole('spinbutton', { name: 'Products in catalog' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Duration, minutes' })).toBeNull();
});
