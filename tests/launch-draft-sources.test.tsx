// @vitest-environment jsdom
/**
 * 1.4.3, found on next: a never-generated Launch has no saved source snapshot, so the
 * editor resolves it live. A re-read of the same, unchanged draft used to wipe that
 * back to null; and a copy made where the browser reports `Europe/Kiev` read as a
 * different setting from its `Europe/Kyiv` original.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchDetail, LaunchSourceSnapshot } from '../packages/shared/src/team/launches';
import {
  canonicalLaunchTimezone,
  launchBrowserTimezone
} from '../packages/shared/src/team/launches/naming';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import { launchConfig, launchSources } from './fixtures/launches';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const config = launchConfig();
const sources: LaunchSourceSnapshot = {
  ...launchSources,
  schemaVersion: 1,
  agentRowId: config.agentRowId,
  offerId: config.offerId,
  buyerId: config.buyerId,
  materialId: config.materialId,
  catalogSettingsVersion: null
};
const detail = (version: string, draft = config): LaunchDetail => ({
  id: 'launch',
  version,
  draft,
  expectedSourceSnapshot: null,
  assigneeId: null,
  workStatus: 'todo',
  activeRevision: null,
  generation: null
});

it('keeps live-resolved sources across a re-read of the same never-generated draft', () => {
  const hook = renderHook(({ value }) => useLaunchDraft(value), {
    initialProps: { value: detail('1') }
  });
  expect(hook.result.current.sources).toBeNull();
  act(() => hook.result.current.resolveSources(sources));
  expect(hook.result.current.sources).toEqual(sources);
  expect(hook.result.current.dirty).toBe(false);
  hook.rerender({ value: detail('2') });
  expect(hook.result.current.sources).toEqual(sources);
  expect(hook.result.current.dirty).toBe(false);
});

it('drops resolved sources when the re-read draft names other sources', () => {
  const hook = renderHook(({ value }) => useLaunchDraft(value), {
    initialProps: { value: detail('1') }
  });
  act(() => hook.result.current.resolveSources(sources));
  const otherOffer = { ...config, offerId: '79999999-0000-4000-8000-0000000000b2' };
  hook.rerender({ value: detail('2', otherOffer) });
  expect(hook.result.current.sources).toBeNull();
});

it('spells launch time zones canonically', () => {
  expect(canonicalLaunchTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
  expect(canonicalLaunchTimezone('Europe/Kyiv')).toBe('Europe/Kyiv');
  expect(canonicalLaunchTimezone('Europe/Warsaw')).toBe('Europe/Warsaw');
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(),
    timeZone: 'Europe/Kiev'
  });
  expect(launchBrowserTimezone()).toBe('Europe/Kyiv');
});
