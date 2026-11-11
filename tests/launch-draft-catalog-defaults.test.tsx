// @vitest-environment jsdom
/**
 * QA MEDIUM-9 (1.4.3): with the Launch dialog open from Generate to the result, the
 * autosave right after the result wrote the draft back without the catalog video fields
 * the generation had filled in (variation count, protocol version, publication). The
 * fresh result then read «settings differ», and the next generation would drop restitch.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
import { launchValuesEqual } from '../packages/shared/src/team/launches/revisions';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import {
  catalogComparable,
  withCatalogGenerationDefaults
} from '../apps/web/src/team/launches/catalogGenerationDefaults';
import { launchConfig, launchSources } from './fixtures/launches';

afterEach(cleanup);

// A catalog draft saved before the video fields existed, or never touched: restitch on,
// but no protocol version, variation count or publication.
const shortDraft = () =>
  launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 20,
      restitchEnabled: true,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  });

const sources = { ...launchSources, schemaVersion: 1 as const, catalogSettingsVersion: null };

const detail = (draft: ReturnType<typeof launchConfig>, version: string): LaunchDetail =>
  ({
    id: 'launch',
    version,
    draft,
    expectedSourceSnapshot: sources,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  }) as unknown as LaunchDetail;

it('fills the catalog video fields a generation sends, and leaves other launches alone', () => {
  const filled = withCatalogGenerationDefaults(shortDraft());
  expect(filled.catalog).toMatchObject({
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' },
    restitchEnabled: true,
    productCount: 20
  });
  expect(withCatalogGenerationDefaults(filled)).toEqual(filled);
  const other = launchConfig();
  expect(withCatalogGenerationDefaults(other)).toBe(other);
});

it('reads a draft without the video fields as the same settings as its generated revision', () => {
  const generated = withCatalogGenerationDefaults(shortDraft());
  expect(launchValuesEqual(shortDraft(), generated)).toBe(false);
  expect(launchValuesEqual(catalogComparable(shortDraft()), catalogComparable(generated))).toBe(
    true
  );
  const moreVariations = {
    ...generated,
    catalog: { ...generated.catalog!, videoVariationCount: 3 }
  };
  expect(launchValuesEqual(catalogComparable(moreVariations), catalogComparable(generated))).toBe(
    false
  );
});

// The hook is driven the way LaunchSession drives it: each receipt and result also hands
// the hook the new Launch detail, whose draft is what the server saved.
const mount = () =>
  renderHook(({ value }: { value: LaunchDetail }) => useLaunchDraft(value), {
    initialProps: { value: detail(shortDraft(), '1') }
  });

it('keeps the generated catalog video fields in the editor after the result, so autosave has nothing to write', () => {
  const { result, rerender } = mount();
  expect(result.current.config.catalog?.videoVariationCount).toBeUndefined();

  // Generate: the editor now holds exactly the config it generates from.
  const submitted = withCatalogGenerationDefaults(result.current.config);
  act(() => result.current.setConfig(submitted));
  // The draft save receipt, then the succeeded result carrying the server's saved draft.
  act(() => result.current.acknowledge(submitted, sources, '2'));
  rerender({ value: detail(submitted, '2') });
  act(() => result.current.adopt(submitted, sources, '3'));
  rerender({ value: detail(submitted, '3') });

  expect(result.current.dirty).toBe(false);
  expect(result.current.config.catalog).toMatchObject({
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' }
  });
});

it('adopts the fuller saved draft when the editor still holds the shorter shape it submitted', () => {
  const { result, rerender } = mount();
  const saved = withCatalogGenerationDefaults(result.current.config);

  // What 1.4.2 did: only the baseline moved, so the shorter editor value read as an edit
  // and the autosave wrote it back over the generated draft.
  act(() => result.current.acknowledge(saved, sources, '2'));
  rerender({ value: detail(saved, '2') });
  expect(result.current.dirty).toBe(true);
  expect(result.current.config.catalog?.videoVariationCount).toBeUndefined();

  act(() => result.current.adopt(saved, sources, '3'));
  rerender({ value: detail(saved, '3') });
  expect(result.current.dirty).toBe(false);
  expect(result.current.config).toEqual(saved);
  expect(result.current.baseVersion).toBe('3');
});
