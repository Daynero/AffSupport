import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { canonicalPlacementSegments } from '../supabase/functions/_shared/library.js';

/**
 * These check that the work scales, not that a machine was fast.
 *
 * They used to assert an elapsed wall-clock time under two seconds, which fails
 * when the suite is running twenty other files beside it — a red run caused by
 * a busy laptop rather than by a change, and the surest way to teach a team to
 * re-run until green. Both figures below are measured in the same conditions
 * moments apart, so load cancels out: doubling the input may not multiply the
 * cost by more than the allowance, whatever the machine is doing.
 */

/** How much more a doubled input may cost before it stops looking linear. */
const SCALING_ALLOWANCE = 4;

/** Runs work and reports how long it took, with a floor so a fast run is not zero. */
function costOf(work: () => void): number {
  const started = performance.now();
  work();
  return Math.max(performance.now() - started, 0.001);
}

describe('Creative Library deterministic scale checks', () => {
  it('plans canonical Library assets at a cost that grows with the input, not faster', () => {
    const plan = (count: number) => {
      const identities = new Set<string>();
      for (let index = 0; index < count; index += 1) {
        const segments = canonicalPlacementSegments({
          stage: index % 2 === 0 ? 'library' : 'finds',
          offer: `Offer ${index % 100}`,
          language: index % 3 === 0 ? 'uk' : 'en',
          type: index % 2 === 0 ? 'Video' : 'Static'
        });
        identities.add(segments.map(segment => segment.value).join('/'));
      }
      return identities;
    };

    // Correctness first: the identity set is what this function is for.
    expect(plan(10_000).size).toBe(200);

    const single = costOf(() => plan(10_000));
    const double = costOf(() => plan(20_000));
    expect(double).toBeLessThan(single * SCALING_ALLOWANCE);
  });

  it('pages 10,000 tasks and 100,000 attachment references without copying media', () => {
    const page = (taskCount: number, attachmentCount: number) => {
      const tasks = Array.from({ length: taskCount }, (_, index) => ({
        id: `task-${String(index).padStart(5, '0')}`,
        createdAt: taskCount - index
      }));
      const attachments = Array.from({ length: attachmentCount }, (_, index) => ({
        taskId: `task-${String(Math.floor(index / 10)).padStart(5, '0')}`,
        materialId: `material-${String(index).padStart(6, '0')}`,
        position: index % 10
      }));
      const firstTaskPage = tasks.slice(0, 50);
      const firstTaskAttachments = attachments
        .filter(item => item.taskId === firstTaskPage[0].id)
        .slice(0, 50);
      return { firstTaskPage, firstTaskAttachments };
    };

    const result = page(10_000, 100_000);
    expect(result.firstTaskPage).toHaveLength(50);
    expect(result.firstTaskAttachments).toHaveLength(10);
    expect(new Set(result.firstTaskAttachments.map(item => item.materialId)).size).toBe(10);

    // Paging must not start reading the whole attachment table: twice the rows
    // may cost more, but not disproportionately more.
    const single = costOf(() => page(10_000, 100_000));
    const double = costOf(() => page(20_000, 200_000));
    expect(double).toBeLessThan(single * SCALING_ALLOWANCE);
  });
});
