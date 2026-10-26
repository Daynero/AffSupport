// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LaunchDraft } from '@video-compressor/shared';
import { launchDefaultValues } from '../packages/shared/src/team/launches/defaults';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';
import {
  resolvedLaunchDefaults,
  useOfferDefaults
} from '../apps/web/src/team/launches/useOfferDefaults';
const api = vi.hoisted(() => ({ defaults: vi.fn(), track: vi.fn() }));
vi.mock('../apps/web/src/api/team', () => ({ launchApi: { defaults: api.defaults } }));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: api.track } }));
const sub = newLaunchDraft().subConfig!;
const profile = (count: number) => ({
  config: { campaignCount: count, maxBudget: 100 },
  subConfig: sub,
  version: '1'
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
function mount(initial = newLaunchDraft(), existing = false) {
  const useHarness = ({
    persisted = existing,
    disabled = false
  }: {
    persisted?: boolean;
    disabled?: boolean;
  }) => {
    const [config, setConfig] = useState<LaunchDraft>(initial);
    const defaults = useOfferDefaults({
      teamId: 'team',
      config,
      workspace: null,
      existing: persisted,
      disabled,
      buyers: [],
      onApply: setConfig
    });
    return { config, setConfig, defaults };
  };
  return renderHook(useHarness, {
    initialProps: { persisted: existing, disabled: false } as {
      persisted?: boolean;
      disabled?: boolean;
    }
  });
}
beforeEach(() => {
  api.defaults.mockReset().mockResolvedValue(null);
  api.track.mockReset();
});
afterEach(cleanup);
it('does not ask to reset a populated draft when no saved profile exists', async () => {
  const { result } = mount({ ...newLaunchDraft(), offerId: 'A', campaignCount: 7 }, true);
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  expect(result.current.defaults.proposal).toBeNull();
  expect(result.current.config.campaignCount).toBe(7);
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(7);
});
it('does not offer to apply a saved profile that already matches the draft', async () => {
  const saved = profile(5);
  api.defaults.mockResolvedValue(saved);
  const { result } = mount({ ...resolvedLaunchDefaults(saved), offerId: 'A' }, true);
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  expect(result.current.defaults.proposal).toBeNull();
  expect(result.current.config.campaignCount).toBe(5);
});
it('asks before applying offer or general settings without leaking A into B', async () => {
  api.defaults.mockImplementation(async (_team, offer) =>
    offer === 'A' ? profile(5) : offer === 'B' ? null : profile(4)
  );
  const { result } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() =>
    result.current.setConfig(old => ({
      ...old,
      offerId: 'A',
      materialId: 'material',
      originalUrl: 'PRIVATE',
      launchDate: '2026-11-10',
      timezone: 'UTC'
    }))
  );
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  expect(result.current.config.campaignCount).toBe(3);
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(5);
  expect(result.current.config).toMatchObject({
    materialId: 'material',
    timezone: newLaunchDraft().timezone
  });
  expect(result.current.defaults.source).toBe('offer');
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'B' })));
  await waitFor(() => expect(result.current.defaults.proposal?.source).toBe('workspace'));
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(4);
  expect(result.current.defaults.source).toBe('workspace');
});
it('protects manual changes before and during a slow read; explicit apply replaces the entire reusable profile', async () => {
  const response = deferred<ReturnType<typeof profile>>();
  api.defaults.mockReturnValue(response.promise);
  const { result } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() =>
    result.current.setConfig(old => ({
      ...old,
      offerId: 'A',
      campaignCount: 2,
      budgetMode: 'manual',
      budgets: [10, 30],
      age: 45
    }))
  );
  act(() => result.current.setConfig(old => ({ ...old, adsCount: 12 })));
  await act(async () => response.resolve(profile(5)));
  expect(result.current.config).toMatchObject({
    campaignCount: 2,
    adsCount: 12,
    age: 45,
    budgets: [10, 30]
  });
  expect(result.current.defaults.proposal).toBeTruthy();
  act(() => result.current.defaults.apply());
  expect(result.current.config).toMatchObject({
    campaignCount: 5,
    adsCount: 3,
    budgetMode: 'auto',
    budgets: null,
    offerId: 'A'
  });
  expect(result.current.config.age).toBeUndefined();
  expect(result.current.config.minBudget).toBeUndefined();
});
it('ignores out-of-order reads and records obsolete work as cancelled', async () => {
  const a = deferred<ReturnType<typeof profile>>();
  const b = deferred<ReturnType<typeof profile>>();
  api.defaults.mockImplementation((_team, offer) => (offer === 'A' ? a.promise : b.promise));
  const { result } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'A' })));
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'B' })));
  await act(async () => b.resolve(profile(6)));
  await act(async () => a.resolve(profile(9)));
  expect(result.current.defaults.proposal?.values.campaignCount).toBe(6);
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(6);
  expect(api.track.mock.calls.some(([event]) => event === 'operation_cancelled')).toBe(true);
});
it('never automatically changes an existing launch; realtime refreshes do not reapply profiles', async () => {
  api.defaults.mockResolvedValue(profile(8));
  const { result, rerender } = mount({ ...newLaunchDraft(), offerId: 'A', campaignCount: 7 }, true);
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  expect(result.current.config.campaignCount).toBe(7);
  rerender({ persisted: true, disabled: false });
  expect(result.current.config.campaignCount).toBe(7);
  act(() => result.current.defaults.keep());
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'B' })));
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  expect(result.current.config.campaignCount).toBe(7);
});
it('a new draft remains eligible for safe defaults after autosave creates its ID', async () => {
  api.defaults.mockResolvedValue(profile(8));
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  rerender({ persisted: true });
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'A' })));
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(8);
});
it('does not turn read failure into a fallback; retries with a new attempt and the same flow', async () => {
  api.defaults
    .mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_PAYLOAD'))
    .mockResolvedValue(profile(6));
  const { result } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'A' })));
  await waitFor(() => expect(result.current.defaults.error).toBeTruthy());
  expect(result.current.config.campaignCount).toBe(3);
  act(() => result.current.defaults.retry());
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(6);
  const starts = api.track.mock.calls.filter(
    ([event, props]) =>
      event === 'operation_started' && props.flow_step === 'launch_defaults_read_offer'
  );
  expect(starts[0][1].flow_id).toBe(starts[1][1].flow_id);
  expect(starts[0][1].attempt_id).not.toBe(starts[1][1].attempt_id);
  expect(JSON.stringify(api.track.mock.calls)).not.toContain('PRIVATE_PROVIDER_PAYLOAD');
});
it('drops an archived buyer with visible warning while preserving a manual budget profile', async () => {
  api.defaults.mockResolvedValue({
    ...profile(3),
    config: {
      campaignCount: 3,
      maxBudget: 30,
      minBudget: 10,
      budgetMode: 'manual',
      budgets: [10, 21, 30],
      buyerId: 'archived'
    }
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'A' })));
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  act(() => result.current.defaults.apply());
  expect(result.current.defaults.buyerMissing).toBe(true);
  expect(result.current.config.buyerId).toBeUndefined();
  expect(result.current.config.budgets).toEqual([10, 21, 30]);
  expect(result.current.config.budgetMode).toBe('manual');
});
it('keeps the defaults payload free of one-off fields and retains complete budget settings', () => {
  expect(
    launchDefaultValues({
      ...newLaunchDraft(),
      offerId: 'A',
      originalUrl: 'PRIVATE',
      materialId: 'M',
      agentRowId: 'R',
      creativeAlias: 'C',
      budgetMode: 'manual',
      budgets: [10, 20, 30]
    })
  ).toMatchObject({ budgetMode: 'manual', budgets: [10, 20, 30] });
  const payload = launchDefaultValues({
    ...newLaunchDraft(),
    offerId: 'A',
    originalUrl: 'PRIVATE',
    materialId: 'M'
  });
  for (const key of ['offerId', 'agentRowId', 'materialId', 'creativeAlias'])
    expect(payload).not.toHaveProperty(key);
  expect(payload.originalUrl).toBe('PRIVATE');
  expect(payload.launchDate).toBe(newLaunchDraft().launchDate);
  expect(resolvedLaunchDefaults(profile(3)).minBudget).toBeUndefined();
});

it('saving an edited offer clears the old proposal while reviewing a version never claims it was applied', async () => {
  api.defaults.mockResolvedValue(profile(8));
  const { result } = mount({ ...newLaunchDraft(), offerId: 'A', campaignCount: 7 });
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  act(() => result.current.setConfig(old => ({ ...old, campaignCount: 4 })));
  act(() =>
    result.current.defaults.saved({ config: result.current.config, subConfig: sub, version: '2' })
  );
  expect(result.current.defaults.proposal).toBeNull();
  act(() => result.current.defaults.apply());
  expect(result.current.config.campaignCount).toBe(4);
  expect(result.current.defaults.source).toBe('offer');
  act(() => result.current.setConfig(old => ({ ...old, campaignCount: 5 })));
  act(() => result.current.defaults.reviewed(profile(9), 'offer'));
  expect(result.current.config.campaignCount).toBe(5);
  expect(result.current.defaults.source).toBe('current');
});

it('restores a saved minimum age and all form values after a new draft chooses the offer; No leaves edits intact', async () => {
  const values: LaunchDraft = {
    ...newLaunchDraft(),
    age: 52,
    campaignCount: 2,
    minBudget: 15,
    maxBudget: 35,
    budgetMode: 'manual',
    budgets: [15, 35],
    adsCount: 8,
    gender: 'W',
    advantagePlus: false,
    launchDate: '2026-11-10',
    timezone: 'Europe/Kiev',
    originalUrl: 'https://example.invalid/?token=SYNTHETIC',
    notes: [{ id: '10000000-0000-4000-8000-000000000001', title: 'Saved', text: 'SYNTHETIC_NOTE' }],
    catalog: {
      productCount: 37,
      restitchEnabled: true,
      finalDurationMode: 'random-centered',
      customFinalDurationSeconds: 1800,
      finalDurationRangeSeconds: [1200, 2400]
    }
  };
  api.defaults.mockResolvedValue({
    config: launchDefaultValues(values),
    subConfig: values.subConfig,
    version: '2'
  });
  const { result } = mount({
    ...newLaunchDraft(),
    age: 21,
    agentRowId: 'current-rk',
    materialId: 'current-creative',
    creativeAlias: 'current-alias'
  });
  await waitFor(() => expect(result.current.defaults.loading).toBe(false));
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'A' })));
  await waitFor(() => expect(result.current.defaults.proposal).toBeTruthy());
  act(() => result.current.defaults.keep());
  expect(result.current.config.age).toBe(21);
  expect(
    api.track.mock.calls.some(([, props]) => props.flow_step === 'launch_defaults_apply_offer')
  ).toBe(false);
  act(() => result.current.setConfig(old => ({ ...old, offerId: 'B' })));
  await waitFor(() => expect(result.current.defaults.proposal?.offerId).toBe('B'));
  act(() => result.current.defaults.apply());
  expect(launchDefaultValues(result.current.config)).toEqual(launchDefaultValues(values));
  expect(result.current.config).toMatchObject({
    offerId: 'B',
    agentRowId: 'current-rk',
    materialId: 'current-creative',
    creativeAlias: 'current-alias',
    age: 52
  });
  expect(result.current.defaults.proposal).toBeNull();
  expect(JSON.stringify(api.track.mock.calls)).not.toContain('SYNTHETIC');
});
