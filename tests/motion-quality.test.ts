import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLiteMotion,
  reportAnimatedTransition,
  resetMotionQualityForTests
} from '../apps/web/src/lib/motion-quality';

beforeEach(() => {
  resetMotionQualityForTests();
});

describe('lite motion (058, R8)', () => {
  it('keeps animating through single long frames, however many', () => {
    for (let index = 0; index < 10; index += 1) reportAnimatedTransition(1);
    expect(isLiteMotion()).toBe(false);
  });

  it('keeps animating when stutters are not in a row', () => {
    reportAnimatedTransition(3);
    reportAnimatedTransition(3);
    reportAnimatedTransition(0);
    reportAnimatedTransition(3);
    reportAnimatedTransition(3);
    expect(isLiteMotion()).toBe(false);
  });

  it('turns lite after three stuttering animations in a row', () => {
    reportAnimatedTransition(2);
    reportAnimatedTransition(4);
    reportAnimatedTransition(2);
    expect(isLiteMotion()).toBe(true);
  });
});
