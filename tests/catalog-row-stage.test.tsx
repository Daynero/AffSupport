// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useSteadyStage } from '../apps/web/src/team/catalog-updater/CatalogRowStage';
import type { TranslationKey } from '../apps/web/src/i18n';

it('keeps a later stage on screen when a poll briefly reads an earlier one', () => {
  // QA round 5: after the video was ready the row flickered between
  // «Перевіряємо таблицю…» and an earlier wording on every poll.
  const { result, rerender } = renderHook(
    ({ identity, label }: { identity: string; label: TranslationKey }) =>
      useSteadyStage(identity, label),
    { initialProps: { identity: 'c:a1', label: 'catalogRunPreparingVideo' as TranslationKey } }
  );
  rerender({ identity: 'c:a1', label: 'catalogUpdaterStageVerifying' });
  expect(result.current).toBe('catalogUpdaterStageVerifying');
  rerender({ identity: 'c:a1', label: 'catalogUpdaterStageBuilding' });
  expect(result.current).toBe('catalogUpdaterStageVerifying');
  rerender({ identity: 'c:a1', label: 'catalogRunVideoWaiting' });
  expect(result.current).toBe('catalogUpdaterStageVerifying');
  rerender({ identity: 'c:a1', label: 'catalogUpdaterStageFinalizing' });
  expect(result.current).toBe('catalogUpdaterStageFinalizing');
});

it('starts over for a new attempt and never holds an unordered wording', () => {
  const { result, rerender } = renderHook(
    ({ identity, label }: { identity: string; label: TranslationKey }) =>
      useSteadyStage(identity, label),
    { initialProps: { identity: 'c:a1', label: 'catalogUpdaterStageVerifying' as TranslationKey } }
  );
  rerender({ identity: 'c:a2', label: 'catalogRunVideoWaiting' });
  expect(result.current).toBe('catalogRunVideoWaiting');
  rerender({ identity: 'c:a2', label: 'catalogVideoCreationCanceling' });
  expect(result.current).toBe('catalogVideoCreationCanceling');
});
