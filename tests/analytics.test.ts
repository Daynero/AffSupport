// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsEventNames, sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { ProductAnalytics } from '../apps/web/src/analytics/service';
import { PRODUCT_SESSION_IDLE_MS, productSessionId } from '../apps/web/src/analytics/session';
import {
  jobTransitionEventNames,
  safeCompressionProperties
} from '../apps/web/src/analytics/compression';
import { makeJob } from './helpers';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('privacy-minimized analytics', () => {
  it('uses an explicit event allowlist', () => {
    expect(analyticsEventNames).toContain('compression_completed');
    expect(analyticsEventNames).toContain('marketing_consent_changed');
    expect(analyticsEventNames).not.toContain('compression_progress');
    expect(analyticsEventNames).not.toContain('file_opened');
  });

  it('keeps only validated aggregate properties and drops personal file data', () => {
    expect(
      sanitizeAnalyticsProperties({
        video_count: 3,
        total_input_bytes: 50_000,
        mode: 'optimal',
        image_embedding: true,
        file_name: 'private.mov',
        inputPath: '/Users/person/private.mov',
        ffmpeg_command: 'ffmpeg /Users/person/private.mov',
        error_category: '/Users/person/private.mov'
      })
    ).toEqual({
      video_count: 3,
      total_input_bytes: 50_000,
      mode: 'optimal',
      image_embedding: true
    });
  });

  it('does not emit analytics for progress-only state changes', () => {
    const previous = makeJob('job', 'processing', { progress: 10 });
    const current = { ...previous, progress: 75 };
    expect(jobTransitionEventNames(previous, current)).toEqual([]);
    expect(jobTransitionEventNames(previous, { ...current, status: 'completed' })).toEqual([
      'compression_completed'
    ]);
  });

  it('builds aggregate compression properties without names or paths', () => {
    const properties = safeCompressionProperties(
      makeJob('secret-file', 'completed', {
        fileName: 'customer-private.mov',
        inputPath: '/Users/customer/customer-private.mov',
        originalSize: 1000,
        finalSize: 600,
        startedAt: 100,
        finishedAt: 600
      })
    );
    expect(properties).toMatchObject({
      video_count: 1,
      total_input_bytes: 1000,
      total_output_bytes: 600,
      saving_percent: 40,
      processing_duration_ms: 500
    });
    expect(JSON.stringify(properties)).not.toMatch(/customer|private\.mov|\/Users/);
  });

  it('uses a random session UUID and renews it only after long inactivity', () => {
    const storage = new MemoryStorage();
    const first = productSessionId(1000, storage);
    const same = productSessionId(1000 + PRODUCT_SESSION_IDLE_MS - 1, storage);
    const renewed = productSessionId(1000 + PRODUCT_SESSION_IDLE_MS * 2, storage);
    expect(same).toBe(first);
    expect(renewed).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('never blocks the product when delivery fails and stops retrying', async () => {
    const storage = new MemoryStorage();
    const sender = vi.fn().mockResolvedValue(false);
    const service = new ProductAnalytics(sender, storage);
    service.setUser('11111111-1111-4111-8111-111111111111');
    expect(() => service.track('home_viewed', {})).not.toThrow();
    await service.flush();
    await service.flush();
    await service.flush();
    expect(sender).toHaveBeenCalledTimes(3);
    expect(service.pendingCount()).toBe(0);
  });

  it('bounds the offline queue instead of storing unlimited events', () => {
    const service = new ProductAnalytics(vi.fn().mockResolvedValue(true), new MemoryStorage());
    service.setUser('11111111-1111-4111-8111-111111111111');
    for (let index = 0; index < 80; index += 1) service.track('home_viewed', {});
    expect(service.pendingCount()).toBeLessThanOrEqual(40);
  });

  it('re-sanitizes browser-queued records before they can be retried', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'wishly.analytics.queue.v1',
      JSON.stringify([
        {
          event_name: 'compression_completed',
          user_id: '11111111-1111-4111-8111-111111111111',
          session_id: '22222222-2222-4222-8222-222222222222',
          tool: 'private.mov',
          properties: { total_input_bytes: 10, file_name: 'private.mov' },
          app_version: 'tampered',
          agent_version: 'v1',
          locale: 'en',
          platform: 'macos',
          attempts: 0
        }
      ])
    );
    const service = new ProductAnalytics(vi.fn().mockResolvedValue(true), storage);
    const saved = storage.getItem('wishly.analytics.queue.v1') ?? '';
    expect(saved).not.toContain('file_name');
    expect(saved).not.toContain('private.mov');
    expect(service.pendingCount()).toBe(1);
  });

  it('never delivers a queued event under a different signed-in identity', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'wishly.analytics.queue.v1',
      JSON.stringify([
        {
          event_name: 'home_viewed',
          user_id: '11111111-1111-4111-8111-111111111111',
          session_id: '22222222-2222-4222-8222-222222222222',
          tool: null,
          properties: {},
          app_version: 'test',
          agent_version: null,
          locale: 'en',
          platform: 'macos',
          attempts: 0
        }
      ])
    );
    const service = new ProductAnalytics(vi.fn().mockResolvedValue(true), storage);
    service.setUser('33333333-3333-4333-8333-333333333333');
    expect(service.pendingCount()).toBe(0);
  });
});
