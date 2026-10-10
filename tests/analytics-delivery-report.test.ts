// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_REPORT_WINDOW_MAX_MS,
  sanitizeAnalyticsEventList
} from '../apps/web/src/analytics/events';
import {
  DELIVERY_COUNTERS_KEY,
  EVENT_TTL_MS,
  MAX_QUEUE_SIZE,
  ProductAnalytics,
  analyticsEventClass,
  type PendingAnalyticsEvent
} from '../apps/web/src/analytics/service';

/**
 * 031 FR-049 — what the queue loses, it counts and reports. A real
 * ProductAnalytics runs against a fake sender; the fake decides what the
 * server accepts, the test watches what the client does about the rest.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const QUEUE_KEY = 'wishly.analytics.queue.v2';

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

const acceptAll = () =>
  vi.fn(async (events: PendingAnalyticsEvent[]) => ({
    acceptedEventIds: events.map(event => event.event_id)
  }));

/** A sender that never answers keeps `flush` busy, so the queue alone is under test. */
const neverAnswers = () => vi.fn(() => new Promise<boolean>(() => {}));

function queuedNames(storage: MemoryStorage): string[] {
  const queue = JSON.parse(storage.getItem(QUEUE_KEY) ?? '[]') as PendingAnalyticsEvent[];
  return queue.map(event => event.event_name);
}

function persistedCounters(storage: MemoryStorage) {
  return JSON.parse(storage.getItem(DELIVERY_COUNTERS_KEY) ?? 'null') as {
    since: string;
    rejected: Record<string, number>;
    evicted: Record<string, number>;
    expired: Record<string, number>;
  } | null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('event classes', () => {
  it('sorts names into progress, informational and terminal', () => {
    for (const name of [
      'estimate_started',
      'estimate_completed',
      'operation_stage_started',
      'operation_stage_completed',
      'tool_impression',
      'feature_impression',
      'home_viewed',
      'screen_viewed'
    ]) {
      expect(analyticsEventClass(name), name).toBe('progress');
    }
    for (const name of [
      'compression_completed',
      'compression_failed',
      'stitch_completed',
      'operation_cancelled',
      'error_occurred',
      'link_lost',
      'link_recovered',
      'team_file_attempt_completed',
      'analytics_delivery_report'
    ]) {
      expect(analyticsEventClass(name), name).toBe('terminal');
    }
    for (const name of [
      'tool_opened',
      'compression_started',
      'setting_changed',
      'link_check_started'
    ]) {
      expect(analyticsEventClass(name), name).toBe('informational');
    }
  });
});

describe('queue bound and eviction by class', () => {
  it('holds sixty events and evicts the oldest progress events first', () => {
    const storage = new MemoryStorage();
    const service = new ProductAnalytics(neverAnswers(), storage);
    service.setUser(USER);
    for (let index = 0; index < 20; index += 1) {
      service.track('compression_completed', { tool_identifier: 'compressor' });
    }
    for (let index = 0; index < 20; index += 1) {
      service.track('tool_opened', { tool_identifier: 'compressor' });
    }
    for (let index = 0; index < 30; index += 1) service.track('home_viewed', {});

    expect(MAX_QUEUE_SIZE).toBe(60);
    expect(service.pendingCount()).toBe(60);
    const names = queuedNames(storage);
    expect(names.filter(name => name === 'compression_completed')).toHaveLength(20);
    expect(names.filter(name => name === 'tool_opened')).toHaveLength(20);
    expect(names.filter(name => name === 'home_viewed')).toHaveLength(20);
    expect(service.deliveryCounters().evicted).toEqual({ home_viewed: 10 });
    expect(persistedCounters(storage)?.evicted).toEqual({ home_viewed: 10 });
  });

  it('evicts informational events before terminal ones, and the terminal only when nothing else is left', () => {
    const storage = new MemoryStorage();
    const service = new ProductAnalytics(neverAnswers(), storage);
    service.setUser(USER);
    for (let index = 0; index < 59; index += 1) {
      service.track('compression_completed', { tool_identifier: 'compressor' });
    }
    service.track('tool_opened', { tool_identifier: 'compressor' });
    // The newest event is the only non-terminal one: it is the victim, not the oldest.
    service.track('home_viewed', {});
    expect(queuedNames(storage)).not.toContain('home_viewed');
    expect(queuedNames(storage)).toContain('tool_opened');
    // Then the informational one goes.
    service.track('compression_failed', { tool_identifier: 'compressor' });
    expect(queuedNames(storage)).not.toContain('tool_opened');
    // All terminal: the oldest terminal event goes.
    service.track('stitch_completed', { tool_identifier: 'stitcher', file_count: 2 });
    expect(service.pendingCount()).toBe(60);
    expect(service.deliveryCounters().evicted).toEqual({
      home_viewed: 1,
      tool_opened: 1,
      compression_completed: 1
    });
  });

  it('never evicts the delivery report', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DELIVERY_COUNTERS_KEY,
      JSON.stringify({
        since: '2026-10-10T11:00:00Z',
        rejected: { team_landing_render: 4 },
        evicted: {},
        expired: {}
      })
    );
    const service = new ProductAnalytics(neverAnswers(), storage);
    service.setUser(USER);
    expect(queuedNames(storage)).toEqual(['analytics_delivery_report']);
    for (let index = 0; index < 70; index += 1) {
      service.track('compression_completed', { tool_identifier: 'compressor' });
    }
    expect(service.pendingCount()).toBe(60);
    expect(queuedNames(storage)[0]).toBe('analytics_delivery_report');
    expect(service.deliveryCounters().evicted).toEqual({ compression_completed: 11 });
  });
});

describe('expiry', () => {
  it('drops events older than seven days by occurred_at, counts them, and reports on the next successful flush', async () => {
    const storage = new MemoryStorage();
    const sender = acceptAll();
    const service = new ProductAnalytics(sender, storage);
    service.setUser(USER);
    service.track('home_viewed', {});
    service.track('tool_opened', { tool_identifier: 'compressor' });

    vi.setSystemTime(Date.now() + EVENT_TTL_MS + 1);
    service.track('compression_completed', { tool_identifier: 'compressor' });
    await service.flush();

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0].map(event => event.event_name)).toEqual([
      'compression_completed'
    ]);
    // The report is queued behind the accepted batch and leaves with the next flush.
    expect(queuedNames(storage)).toEqual(['analytics_delivery_report']);
    await service.flush();

    const report = sender.mock.calls[1][0][0];
    expect(report.event_name).toBe('analytics_delivery_report');
    expect(report.properties).toEqual({
      rejected_count: 0,
      evicted_count: 0,
      expired_count: 2,
      report_window_ms: DELIVERY_REPORT_WINDOW_MAX_MS
    });
    expect(report.tool).toBeNull();
    expect(service.pendingCount()).toBe(0);
    // Accepted: the counters it carried are gone.
    expect(service.deliveryCounters()).toMatchObject({ rejected: {}, evicted: {}, expired: {} });
    expect(persistedCounters(storage)).toMatchObject({ rejected: {}, evicted: {}, expired: {} });
  });

  it('counts an event that exhausts its retry budget as expired', async () => {
    const storage = new MemoryStorage();
    const service = new ProductAnalytics(vi.fn().mockResolvedValue(false), storage);
    service.setUser(USER);
    service.track('home_viewed', {});
    await service.flush();
    await service.flush();
    expect(service.deliveryCounters().expired).toEqual({});
    await service.flush();
    expect(service.pendingCount()).toBe(0);
    expect(service.deliveryCounters().expired).toEqual({ home_viewed: 1 });
  });
});

describe('server rejections', () => {
  it('counts a rejected event by name, stops retrying it, and lists it in the report', async () => {
    const storage = new MemoryStorage();
    const sender = vi.fn(async (events: PendingAnalyticsEvent[]) => ({
      acceptedEventIds: events
        .filter(event => event.event_name !== 'tool_opened')
        .map(event => event.event_id)
    }));
    const service = new ProductAnalytics(sender, storage);
    service.setUser(USER);
    service.track('home_viewed', {});
    service.track('tool_opened', { tool_identifier: 'compressor' });
    service.track('tool_opened', { tool_identifier: 'stitcher' });
    await service.flush();

    // The report is queued in the same flush and takes the counters with it.
    expect(queuedNames(storage)).toEqual(['analytics_delivery_report']);
    expect(service.deliveryCounters().rejected).toEqual({});
    await service.flush();

    const report = sender.mock.calls[1][0][0];
    expect(report.properties).toEqual({
      rejected_count: 2,
      evicted_count: 0,
      expired_count: 0,
      rejected_events: 'tool_opened',
      report_window_ms: 0
    });
    expect(service.pendingCount()).toBe(0);
    expect(service.deliveryCounters().rejected).toEqual({});
  });

  it('does not report a refused report, so a refusal cannot loop', async () => {
    const storage = new MemoryStorage();
    const sender = vi.fn(async (events: PendingAnalyticsEvent[]) => ({
      acceptedEventIds: events
        .filter(event => event.event_name === 'home_viewed')
        .map(event => event.event_id)
    }));
    const service = new ProductAnalytics(sender, storage);
    service.setUser(USER);
    service.track('home_viewed', {});
    service.track('tool_opened', { tool_identifier: 'compressor' });
    await service.flush();
    expect(queuedNames(storage)).toEqual(['analytics_delivery_report']);
    await service.flush();
    expect(service.pendingCount()).toBe(0);
    expect(service.deliveryCounters()).toMatchObject({ rejected: {}, evicted: {}, expired: {} });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('lists the most frequently lost names first, at most ten, inside the guard length', () => {
    expect(sanitizeAnalyticsEventList('home_viewed,unknown_event,home_viewed,tool_opened')).toBe(
      'home_viewed,tool_opened'
    );
    const many = [
      'team_library_processing_completed',
      'team_library_batch_completed',
      'team_file_attempt_completed',
      'team_file_attempt_started',
      'team_workflow_completed',
      'team_workflow_started',
      'team_landing_gallery_view',
      'team_storage_connected',
      'team_index_completed',
      'team_previews_ready',
      'team_storage_attention',
      'home_viewed'
    ].join(',');
    const list = sanitizeAnalyticsEventList(many) ?? '';
    expect(list.length).toBeLessThanOrEqual(128);
    expect(list.split(',').length).toBeLessThanOrEqual(10);
    expect(list.startsWith('team_library_processing_completed')).toBe(true);
    expect(sanitizeAnalyticsEventList('')).toBeUndefined();
    expect(sanitizeAnalyticsEventList(42)).toBeUndefined();
  });
});

describe('session start', () => {
  it('reports counters persisted by an earlier session once a user is known', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DELIVERY_COUNTERS_KEY,
      JSON.stringify({
        since: '2026-10-10T11:30:00Z',
        rejected: { team_landing_render: 3, power_limit_changed: 1 },
        evicted: { estimate_completed: 7 },
        expired: {}
      })
    );
    const sender = acceptAll();
    const service = new ProductAnalytics(sender, storage);
    expect(service.pendingCount()).toBe(0);
    service.setUser(USER);
    expect(queuedNames(storage)).toEqual(['analytics_delivery_report']);
    await service.flush();

    const report = sender.mock.calls[0][0][0];
    expect(report.event_name).toBe('analytics_delivery_report');
    expect(report.properties).toEqual({
      rejected_count: 4,
      evicted_count: 7,
      expired_count: 0,
      rejected_events: 'team_landing_render,power_limit_changed',
      evicted_events: 'estimate_completed',
      report_window_ms: 30 * 60_000
    });
    expect(persistedCounters(storage)).toMatchObject({ rejected: {}, evicted: {}, expired: {} });
    // Nothing more to say until something else is lost.
    service.track('home_viewed', {});
    await service.flush();
    expect(sender.mock.calls[1][0].map(event => event.event_name)).toEqual(['home_viewed']);
    expect(service.pendingCount()).toBe(0);
  });

  it('ignores a tampered counter file', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DELIVERY_COUNTERS_KEY,
      JSON.stringify({ rejected: { file_opened: 5, home_viewed: -1, tool_opened: 'many' } })
    );
    const service = new ProductAnalytics(acceptAll(), storage);
    service.setUser(USER);
    expect(service.pendingCount()).toBe(0);
    expect(service.deliveryCounters().rejected).toEqual({});
  });
});

describe('envelope v3', () => {
  it('lifts attempt_id out of properties and carries the Agent identity when known', async () => {
    const sender = acceptAll();
    const service = new ProductAnalytics(sender, new MemoryStorage());
    service.setUser(USER);
    service.setAgentContext({
      version: '1.2.5',
      buildId: 'build-1',
      channel: 'stable',
      apiVersion: 7,
      toolContracts: {},
      instanceId: '88888888-8888-4888-8888-888888888888',
      platform: 'macos'
    });
    service.track('team_file_attempt_started', {
      attempt_id: 'attempt_01',
      action: 'download',
      storage_kind: 'shared_drive',
      size_bucket: 'agent',
      cache_state: 'cold',
      attempt_number: 1,
      stage: 'downloading'
    });
    service.setAgentContext({
      version: null,
      buildId: null,
      channel: null,
      apiVersion: null,
      toolContracts: {},
      instanceId: 'not-a-uuid',
      platform: 'linux' as unknown as 'macos'
    });
    service.track('home_viewed', {});
    await service.flush();

    const [attempt, home] = sender.mock.calls[0][0];
    expect(attempt).toMatchObject({
      event_version: 2,
      attempt_id: 'attempt_01',
      agent_instance_id: '88888888-8888-4888-8888-888888888888',
      agent_platform: 'macos'
    });
    expect(attempt.properties).toEqual({
      action: 'download',
      storage_kind: 'shared_drive',
      size_bucket: 'agent',
      cache_state: 'cold',
      attempt_number: 1,
      stage: 'downloading'
    });
    expect(home).toMatchObject({ attempt_id: null, agent_instance_id: null, agent_platform: null });
  });
});
