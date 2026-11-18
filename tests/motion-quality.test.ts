import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LITE_SPELL_MS,
  isLiteMotion,
  reportAnimatedTransition,
  resetMotionQualityForTests
} from '../apps/web/src/lib/motion-quality';

beforeEach(() => {
  resetMotionQualityForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lite motion (058, R8)', () => {
  it('keeps animating through a couple of long frames, however often', () => {
    for (let index = 0; index < 10; index += 1) reportAnimatedTransition(2);
    expect(isLiteMotion()).toBe(false);
  });

  it('keeps animating when stutters are not in a row', () => {
    for (const frames of [4, 4, 4, 0, 4, 4, 4]) reportAnimatedTransition(frames);
    expect(isLiteMotion()).toBe(false);
  });

  it('turns lite after four stuttering animations in a row, and only for a spell', () => {
    vi.useFakeTimers();
    for (const frames of [3, 5, 3, 4]) reportAnimatedTransition(frames);
    expect(isLiteMotion()).toBe(true);
    vi.advanceTimersByTime(LITE_SPELL_MS + 1);
    expect(isLiteMotion()).toBe(false);
  });
});
