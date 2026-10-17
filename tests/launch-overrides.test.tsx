// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchResult } from '../apps/web/src/team/launches/LaunchResult';
import { mergeLaunchOverrides } from '../apps/web/src/team/launches/useLaunchOverrides';
import type { LaunchOverrides, LaunchRevision } from '../packages/shared/src/team/launches';
import { launchPreview } from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function copyValue(label: string, index = 0) {
  const button = screen.getAllByRole('button', { name: `Copy ${label}` })[index];
  return button.querySelector('.launch-result-text')?.textContent;
}
function fixture() {
  const config = launchConfig({ method: 'catalog' });
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  return {
    id: 'revision',
    revisionNo: 1,
    kind: 'generated',
    baselineRevisionId: null,
    config,
    sources: launchSources,
    baseline: preview.value,
    overrides: {},
    createdAt: '2026-10-13T00:00:00Z',
    catalog: {
      id: 'catalog',
      materialId: 'catalog',
      variant: 1,
      name: 'Catalog',
      url: 'https://docs.google.com/spreadsheets/d/synthetic',
      restitchMaterialId: null
    }
  } satisfies LaunchRevision;
}
it('rebases local output edits without dropping unrelated changes from another session', () => {
  expect(
    mergeLaunchOverrides(
      { catalogName: 'Generated', campaigns: { '1': { name: 'Campaign', budget: '10' } } },
      { catalogName: 'Manual', campaigns: { '1': { name: 'Edited campaign', budget: '10' } } },
      {
        catalogName: 'Generated',
        catalogUrl: 'https://docs.google.com/spreadsheets/d/remote',
        campaigns: { '1': { name: 'Campaign', budget: '20' } },
        subValues: { sub1: 'remote' }
      }
    )
  ).toEqual({
    catalogName: 'Manual',
    catalogUrl: 'https://docs.google.com/spreadsheets/d/remote',
    campaigns: { '1': { name: 'Edited campaign', budget: '20' } },
    subValues: { sub1: 'remote' }
  });
});
it('keeps SUB values in the revision while omitting them from the compact result', () => {
  const revision = fixture();
  const write = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  function Harness() {
    const [overrides, setOverrides] = useState<LaunchOverrides>({});
    return (
      <LaunchResult
        revision={revision}
        overrides={overrides}
        onChange={setOverrides}
        onSave={save}
        editable
        disabled={false}
      />
    );
  }
  render(<Harness />);
  expect(screen.queryByRole('button', { name: 'Edit SUB 1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy SUB 1' })).toBeNull();
  expect(revision.baseline.subValues.sub1).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it('keeps viewer outputs copyable while hiding edit and save actions', async () => {
  const revision = fixture();
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  render(
    <LaunchResult
      revision={revision}
      overrides={{}}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable={false}
      disabled={false}
    />
  );
  expect(screen.queryByRole('button', { name: /Edit / })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  });
  expect(write).toHaveBeenCalledWith(revision.baseline.advertisingUrl);
});
it('does not show a manual save button or autosave while result edits are locked', () => {
  const save = vi.fn();
  render(
    <LaunchResult
      revision={fixture()}
      overrides={{ subValues: { sub1: 'manual_buyer' } }}
      onChange={vi.fn()}
      onSave={save}
      editable
      disabled
    />
  );
  const edit = screen.getByRole('button', { name: 'Edit URL' });
  expect(edit).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Save manual changes' })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it('edits and copies every result field, saves the current override map and reopens it without mutating generated values', async () => {
  const revision = fixture();
  const original = JSON.stringify(revision);
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  let saved: LaunchOverrides = {};
  function Harness({ initial = {} }: { initial?: LaunchOverrides }) {
    const [overrides, setOverrides] = useState(initial);
    return (
      <LaunchResult
        revision={revision}
        overrides={overrides}
        onChange={setOverrides}
        onSave={() => {
          saved = overrides;
        }}
        editable
        disabled={false}
      />
    );
  }
  const view = render(<Harness />);
  vi.useFakeTimers();
  const changes = [
    ['URL', 'https://example.com/landing?sub1=manual'],
    ['Catalog name', 'Manual catalog'],
    ['Catalog URL', 'https://docs.google.com/spreadsheets/d/manual'],
    ['Campaign name #1', 'Manual campaign']
  ];
  for (const [label, value] of changes) {
    const previousWrites = write.mock.calls.length;
    fireEvent.click(screen.getAllByRole('button', { name: `Edit ${label}` })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
    if (label === 'URL' || label === 'Catalog URL')
      expect(
        screen
          .getAllByRole('link', { name: 'Open link in a new tab' })
          .some(link => link.getAttribute('href') === value)
      ).toBe(true);
    expect(write).toHaveBeenCalledTimes(previousWrites);
    fireEvent.keyDown(screen.getByRole('textbox', { name: label }), { key: 'Enter' });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: `Copy ${label}` })[0]);
    });
    expect(write).toHaveBeenLastCalledWith(value);
  }
  expect(JSON.stringify(revision)).toBe(original);
  expect(screen.getAllByText('Changed manually')).toHaveLength(changes.length);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  expect(saved).toMatchObject({
    advertisingUrl: changes[0][1],
    catalogName: changes[1][1],
    catalogUrl: changes[2][1],
    campaigns: { '1': { name: changes[3][1] } }
  });
  view.unmount();
  render(<Harness initial={saved} />);
  expect(screen.getAllByText('Changed manually')).toHaveLength(changes.length);
  expect(screen.queryByRole('button', { name: 'Copy Budget' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy Ad numbers' })).toBeNull();
  for (const [label, value] of changes) expect(copyValue(label)).toBe(value);
  fireEvent.click(
    within(screen.getByText('Catalog name').closest('.launch-result-row') as HTMLElement).getByRole(
      'button',
      { name: 'Restore generated' }
    )
  );
  expect(copyValue('Catalog name')).toBe(revision.catalog?.name);
  expect(copyValue('URL')).toBe(changes[0][1]);
});

it('warns about changed settings without modifying the saved result', () => {
  const revision = fixture();
  const view = render(
    <LaunchResult
      revision={revision}
      overrides={{}}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable
      disabled={false}
      settingsChanged
    />
  );
  expect(screen.getByText('Settings differ from this saved result.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy URL' }).textContent).toContain(
    revision.baseline.advertisingUrl
  );
  view.rerender(
    <LaunchResult
      revision={revision}
      overrides={{}}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable
      disabled={false}
    />
  );
  expect(screen.queryByText('Settings differ from this saved result.')).toBeNull();
});

it('keeps stored budget and range overrides while showing only copyable campaign names', () => {
  const revision = fixture();
  const original = JSON.stringify(revision);
  const overrides: LaunchOverrides = {
    advertisingUrl: 'https://example.invalid/?sub1=manual',
    campaigns: { '1': { budget: '17', adRange: '7-9' } },
    subValues: { sub1: 'manual_buyer' }
  };
  render(
    <LaunchResult
      revision={revision}
      overrides={overrides}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable
      disabled={false}
    />
  );
  expect(screen.getAllByText('Changed manually')).not.toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Copy SUB 1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy Budget' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy Ad numbers' })).toBeNull();
  expect(copyValue('Campaign name #1')).toBe(revision.baseline.campaigns[0].name);
  expect(screen.getByText('$17')).toBeTruthy();
  expect(JSON.stringify(revision)).toBe(original);
});
