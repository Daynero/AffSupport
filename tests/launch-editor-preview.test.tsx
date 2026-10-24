// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchEditor } from '../apps/web/src/team/launches/LaunchEditor';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';
import { launchConfig, launchFixtureAccounts, launchSources } from './fixtures/launches';
import type { LaunchDraft } from '../packages/shared/src/team';

vi.mock('../apps/web/src/team/launches/LaunchCreativePicker', () => ({
  LaunchCreativePicker: () => null
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('reveals the failing SUB setting when generation rejects a non-Latin social value', () => {
  const config = launchConfig();
  render(
    <LaunchEditor
      teamId="team"
      config={config}
      sources={{
        ...launchSources,
        social: 'Тест',
        schemaVersion: 1,
        agentRowId: config.agentRowId,
        offerId: config.offerId,
        buyerId: config.buyerId,
        materialId: config.materialId,
        catalogSettingsVersion: null
      }}
      accounts={launchFixtureAccounts()}
      offers={[]}
      buyers={[]}
      disabled={false}
      submitted
      onChange={vi.fn()}
      onRefreshSources={vi.fn()}
    />
  );
  expect(
    screen.getByRole('button', { name: /Fill values in the URL/u }).getAttribute('aria-expanded')
  ).toBe('true');
  expect(screen.getByRole('button', { name: 'SUB2' })).toBeTruthy();
  expect(
    screen.getByText('Use Latin letters, digits, underscores or hyphens for SUB values.')
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Fill values in the URL/u }));
  expect(screen.getByRole('button', { name: 'SUB2' })).toBeTruthy();
});

it('distinguishes equal account suffixes and updates campaign names without IO', () => {
  const initial = launchConfig();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const refresh = vi.fn();
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(initial);
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={launchFixtureAccounts()}
        offers={[{ id: initial.offerId, value: 'ProCaps TR', updatedAt: '2026-10-12T00:00:00Z' }]}
        buyers={[{ id: initial.buyerId, value: 'patrik', updatedAt: '2026-10-12T00:00:00Z' }]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={refresh}
      />
    );
  }
  render(<Host />);
  fireEvent.click(screen.getByRole('button', { name: /Preview/u }));
  expect(screen.getByText('[g1-892-v5] ProCaps TR $10 m45+ 13/10 #1(1-3)')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveProperty('value', 'g1 · 892');
  expect((screen.getByText('Ad account').closest('label') as HTMLLabelElement).htmlFor).toBe(
    screen.getByRole('combobox', { name: 'Ad account' }).id
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ad account' }));
  expect(screen.getByRole('option', { name: 'g1 · 892, ID 1234567892' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'g2 · 892, ID 9876543892' })).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: 'g1 · 892, ID 1234567892' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '5' }
  });
  expect(screen.getByText('[g1-892-v5] ProCaps TR $10 m45+ 13/10 #1(1-3)')).toBeTruthy();
  expect(screen.getByText('[g1-892-v5] ProCaps TR $30 m45+ 13/10 #5(13-15)')).toBeTruthy();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum age' }), {
    target: { value: '100' }
  });
  expect(screen.getByText('[g1-892-v5] ProCaps TR $10 m100+ 13/10 #1(1-3)')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }));
  expect(screen.getByText('[g1-892-v5-c] ProCaps TR $10 m100+ 13/10 #1(1-3)')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText(/sub1=patrik/u)).toBeNull();
});

it('keeps incomplete URL neutral until edited, then explains validation errors', () => {
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(() => newLaunchDraft());
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={vi.fn()}
      />
    );
  }
  render(<Host />);
  const url = screen.getByRole('textbox', { name: 'URL' });
  const notice = document.querySelector('.launch-editor-url-warning');
  expect(notice).not.toBeNull();
  expect(url.closest('.bg-warning-soft')).toBeNull();
  expect(screen.queryByText('Required')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(url, { target: { value: 'invalid-url' } });
  expect(
    screen.getByText('Enter a valid HTTP(S) URL without spaces or control characters.')
  ).toBeTruthy();
  fireEvent.change(url, { target: { value: 'https://example.invalid/?sub1=old' } });
  expect(url.closest('.bg-warning-soft')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(
    screen.getByText('SUB2, SUB3 not found in the URL; these parameters will be left unchanged.')
  ).toBeTruthy();
  expect(screen.queryByText(/SUB1 not found/u)).toBeNull();
  expect(document.querySelector('.launch-editor-url-warning')).toBe(notice);
  fireEvent.change(url, { target: { value: 'https://example.invalid/?sub1=a&sub2=b&sub3=c' } });
  expect(document.querySelector('.launch-editor-url-warning')).toBe(notice);
  expect(notice?.textContent).toBe('');
  expect(notice?.getAttribute('data-reserve')).toContain('SUB1, SUB2, SUB3');
});

it('explains an empty required Buyer after submit without tinting the field background', () => {
  render(
    <LaunchEditor
      teamId="team"
      config={{ ...launchConfig(), buyerId: undefined }}
      sources={null}
      accounts={launchFixtureAccounts()}
      offers={[]}
      buyers={[]}
      disabled={false}
      submitted
      onChange={vi.fn()}
      onRefreshSources={vi.fn()}
    />
  );
  const buyer = screen.getByRole('combobox', { name: 'Buyer' });
  expect(buyer.closest('.bg-warning-soft')).toBeNull();
  expect(buyer.closest('.ui-field')?.querySelector('.ui-field-required')).toBeNull();
  expect(
    screen.queryByLabelText('Required values are checked when you generate the launch.')
  ).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Check the value');
});

it('keeps the campaign count and ads count adjacent and switches compact budget modes', () => {
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(() => launchConfig());
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={launchFixtureAccounts()}
        offers={[{ id: launchConfig().offerId, value: 'ProCaps TR', updatedAt: '2026-10-12' }]}
        buyers={[{ id: launchConfig().buyerId, value: 'patrik', updatedAt: '2026-10-12' }]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={vi.fn()}
      />
    );
  }
  render(<Host />);
  expect(screen.getByRole('spinbutton', { name: 'Campaign count' })).toBeTruthy();
  expect(screen.getByRole('spinbutton', { name: 'Maximum' })).toBeTruthy();
  expect(screen.getByRole('spinbutton', { name: 'Ads in each campaign' })).toBeTruthy();
  expect(screen.getByRole('spinbutton', { name: 'Minimum age' })).toBeTruthy();
  expect(screen.queryByRole('spinbutton', { name: 'Campaign budgets 1' })).toBeNull();
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('10 $20 $30 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum' }), {
    target: { value: '60' }
  });
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('10 $35 $60 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum' }), {
    target: { value: '30' }
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
  expect(screen.queryByRole('spinbutton', { name: 'Maximum' })).toBeNull();
  expect(screen.getByRole('spinbutton', { name: 'Campaign budgets 1' })).toHaveProperty(
    'value',
    '10'
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign budgets 1' }), {
    target: { value: '11' }
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
  expect(screen.getByRole('spinbutton', { name: 'Maximum' })).toHaveProperty('value', '30');
  fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
  expect(screen.getByRole('spinbutton', { name: 'Campaign budgets 1' })).toHaveProperty(
    'value',
    '11'
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '4' }
  });
  expect(screen.getByRole('spinbutton', { name: 'Campaign budgets 4' })).toHaveProperty(
    'value',
    ''
  );
  expect(screen.getByRole('spinbutton', { name: 'Campaign budgets 1' })).toHaveProperty(
    'value',
    '11'
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '2' }
  });
  expect(screen.queryByRole('spinbutton', { name: 'Campaign budgets 3' })).toBeNull();
  expect(screen.getByRole('spinbutton', { name: 'Campaign budgets 2' })).toHaveProperty(
    'value',
    '20'
  );
  expect(screen.getByRole('textbox', { name: 'URL' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Fill values in the URL/u }));
  expect(screen.getByRole('button', { name: 'SUB1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'SUB2' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'SUB3' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh sources' })).toBeTruthy();
});

it('switches restitch time between a point and an independently editable interval', () => {
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(() =>
      launchConfig({
        method: 'catalog',
        catalog: {
          productCount: 100,
          restitchEnabled: true,
          finalDurationMode: 'custom',
          customFinalDurationSeconds: 30 * 60
        }
      })
    );
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={vi.fn()}
      />
    );
  }
  render(<Host />);
  expect(screen.getAllByRole('slider')).toHaveLength(1);
  expect(screen.getByText('30 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Random range' }));
  expect(screen.getAllByRole('slider')).toHaveLength(2);
  expect(screen.getByText('25–35 min')).toBeTruthy();
  fireEvent.keyDown(screen.getAllByRole('slider')[1], { key: 'ArrowRight' });
  fireEvent.keyUp(screen.getAllByRole('slider')[1], { key: 'ArrowRight' });
  expect(screen.getByText('25–36 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exact' }));
  expect(screen.getAllByRole('slider')).toHaveLength(1);
  expect(screen.getByText('31 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Random range' }));
  expect(screen.getAllByRole('slider')).toHaveLength(2);
  expect(screen.getByText('26–36 min')).toBeTruthy();
});

it('keeps a centered random interval inside the 1–60 minute scale at the upper edge', () => {
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(() =>
      launchConfig({
        method: 'catalog',
        catalog: {
          productCount: 100,
          restitchEnabled: true,
          finalDurationMode: 'random-centered',
          customFinalDurationSeconds: 60 * 60
        }
      })
    );
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={vi.fn()}
      />
    );
  }
  render(<Host />);
  expect(screen.getByText('55–60 min')).toBeTruthy();
  fireEvent.keyDown(screen.getAllByRole('slider')[1], { key: 'ArrowLeft' });
  fireEvent.keyUp(screen.getAllByRole('slider')[1], { key: 'ArrowLeft' });
  expect(screen.getByText('55–59 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exact' }));
  expect(screen.getByText('57 min')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Random range' }));
  expect(screen.getByText('52–60 min')).toBeTruthy();
});

it('updates automatic budgets from both bounds and changes the heading for one campaign', () => {
  function Host() {
    const [config, setConfig] = React.useState<LaunchDraft>(() =>
      launchConfig({ minBudget: 10, maxBudget: 30 })
    );
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onChange={patch => setConfig(current => ({ ...current, ...patch }))}
        onRefreshSources={vi.fn()}
      />
    );
  }
  render(<Host />);
  expect(screen.getByText('Set campaign budgets')).toBeTruthy();
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('10 $20 $30 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum' }), {
    target: { value: '20' }
  });
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('20 $25 $30 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum' }), {
    target: { value: '60' }
  });
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('20 $40 $60 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '1' }
  });
  expect(screen.getByText('Set campaign budget')).toBeTruthy();
  expect(screen.getByLabelText('Campaign budgets').textContent).toBe('60 $');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum' }), { target: { value: '' } });
  expect(screen.getByRole('spinbutton', { name: 'Minimum' })).toHaveProperty('value', '');
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});
