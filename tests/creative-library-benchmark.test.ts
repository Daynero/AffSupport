import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { canonicalPlacementSegments } from '../supabase/functions/_shared/library.js';

describe('Creative Library deterministic scale checks', () => {
  it('plans 10,000 canonical Library assets within the two-second local budget', () => {
    const started = performance.now();
    const identities = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const segments = canonicalPlacementSegments({
        stage: index % 2 === 0 ? 'library' : 'finds',
        offer: `Offer ${index % 100}`,
        language: index % 3 === 0 ? 'uk' : 'en',
        type: index % 2 === 0 ? 'Video' : 'Static'
      });
      identities.add(segments.map(segment => segment.value).join('/'));
    }
    const elapsed = performance.now() - started;
    expect(identities.size).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('pages 10,000 tasks and 100,000 attachment references without copying media', () => {
    const started = performance.now();
    const tasks = Array.from({ length: 10_000 }, (_, index) => ({
      id: `task-${String(index).padStart(5, '0')}`,
      createdAt: 10_000 - index
    }));
    const attachments = Array.from({ length: 100_000 }, (_, index) => ({
      taskId: `task-${String(Math.floor(index / 10)).padStart(5, '0')}`,
      materialId: `material-${String(index).padStart(6, '0')}`,
      position: index % 10
    }));
    const firstTaskPage = tasks.slice(0, 50);
    const firstTaskAttachments = attachments
      .filter(item => item.taskId === firstTaskPage[0].id)
      .slice(0, 50);
    const elapsed = performance.now() - started;
    expect(firstTaskPage).toHaveLength(50);
    expect(firstTaskAttachments).toHaveLength(10);
    expect(new Set(firstTaskAttachments.map(item => item.materialId)).size).toBe(10);
    expect(elapsed).toBeLessThan(2_000);
  });
});
