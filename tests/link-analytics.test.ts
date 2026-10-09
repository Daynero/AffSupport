// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { browserFamilyFromUserAgent } from '../apps/web/src/lib/browser';
import {
  LINK_DURATION_MAX_MS,
  analyticsEventNames,
  sanitizeAnalyticsProperties
} from '../apps/web/src/analytics/events';
import {
  linkOrigin,
  trackBlockedByBrowser,
  trackLinkCheckCompleted,
  trackLinkCheckStarted,
  trackLinkInconsistency,
  trackLinkLost,
  trackLinkRecovered,
  trackPairing,
  trackReconnectClicked
} from '../apps/web/src/analytics/link';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';

/**
 * 032 — every link event the web emits must survive both sanitizers: the
 * client one in events.ts and the database guard the migration installs.
 * The second half of this file loads the guard's real body into PGlite and
 * feeds it the very properties the first half delivered.
 */

const MIGRATION = 'supabase/migrations/20261110100000_link_analytics_keys.sql';
const USER = '11111111-1111-4111-8111-111111111111';
const FLOW = '44444444-4444-4444-8444-444444444444';

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

async function deliverAll(): Promise<PendingAnalyticsEvent[]> {
  const sender = vi.fn(async (events: PendingAnalyticsEvent[]) => ({
    acceptedEventIds: events.map(event => event.event_id)
  }));
  const service = new ProductAnalytics(sender, new MemoryStorage());
  service.setUser(USER);

  trackLinkCheckStarted({ flowId: FLOW, trigger: 'visibility' }, service);
  trackLinkCheckCompleted(
    { flowId: FLOW, outcome: 'failure', reason: 'not_running', stage: 'probe', durationMs: 812.4 },
    service
  );
  trackLinkCheckCompleted({ flowId: FLOW, outcome: 'success', durationMs: 240 }, service);
  trackLinkLost({ flowId: FLOW, transport: 'watchdog', reason: 'timeout' }, service);
  trackLinkRecovered(
    {
      flowId: FLOW,
      durationMs: 5_000,
      mode: 'manual',
      instanceChanged: true,
      tokenChanged: false
    },
    service
  );
  trackReconnectClicked({ flowId: FLOW, surface: 'team_process_dialog' }, service);
  trackBlockedByBrowser(service);
  trackLinkInconsistency({ flowId: FLOW, errorCode: 'unauthorized', streamOpen: true }, service);
  trackPairing('started', { flowId: FLOW, method: 'fragment' }, service);
  trackPairing(
    'failed',
    { flowId: FLOW, method: 'handshake', reason: 'pairing_rejected' },
    service
  );
  trackLinkRecovered(
    {
      flowId: FLOW,
      durationMs: Number.POSITIVE_INFINITY,
      mode: 'auto',
      instanceChanged: false,
      tokenChanged: true
    },
    service
  );

  await service.flush();
  return sender.mock.calls.flatMap(([events]) => events);
}

describe('browser family', () => {
  it('classifies the five families without a fingerprint', () => {
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const edge = `${chrome} Edg/126.0.2592.68`;
    const iosChrome =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
    const firefox =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0';
    expect(browserFamilyFromUserAgent(safari)).toBe('safari');
    expect(browserFamilyFromUserAgent(chrome)).toBe('chrome');
    expect(browserFamilyFromUserAgent(edge)).toBe('edge');
    expect(browserFamilyFromUserAgent(iosChrome)).toBe('chrome');
    expect(browserFamilyFromUserAgent(firefox)).toBe('firefox');
    expect(browserFamilyFromUserAgent('curl/8.6.0')).toBe('other');
    expect(browserFamilyFromUserAgent('')).toBe('other');
  });
});

describe('link analytics helpers', () => {
  it('names every link event in the allowlist', () => {
    for (const name of [
      'link_check_started',
      'link_check_completed',
      'link_lost',
      'link_recovered',
      'reconnect_clicked',
      'blocked_by_browser_detected',
      'link_inconsistency'
    ]) {
      expect(analyticsEventNames).toContain(name);
    }
  });

  it('reports the hosted origin for a page the Agent does not serve', () => {
    expect(linkOrigin()).toBe('hosted');
  });

  it('emits every event through the real client sanitizer with its properties intact', async () => {
    const delivered = await deliverAll();
    expect(delivered.map(event => event.event_name)).toEqual([
      'link_check_started',
      'link_check_completed',
      'link_check_completed',
      'link_lost',
      'link_recovered',
      'reconnect_clicked',
      'blocked_by_browser_detected',
      'link_inconsistency',
      'pairing_started',
      'pairing_failed',
      'link_recovered'
    ]);
    const [
      started,
      failedCheck,
      succeededCheck,
      lost,
      recovered,
      clicked,
      blocked,
      inconsistency,
      pairingStarted,
      pairingFailed,
      recoveredLater
    ] = delivered;

    expect(started.flow_id).toBe(FLOW);
    expect(started.properties).toEqual({
      link_trigger: 'visibility',
      link_origin: 'hosted',
      browser_family: 'other'
    });
    expect(failedCheck.properties).toEqual({
      outcome: 'failure',
      link_reason: 'not_running',
      link_stage: 'probe',
      duration_ms: 812
    });
    expect(failedCheck.outcome).toBe('failure');
    expect(succeededCheck.properties).toEqual({ outcome: 'success', duration_ms: 240 });
    expect(lost.properties).toEqual({ link_transport: 'watchdog', link_reason: 'timeout' });
    expect(recovered.properties).toEqual({
      duration_ms: 5_000,
      recovery_mode: 'manual',
      instance_changed: true,
      token_changed: false
    });
    expect(clicked.properties).toEqual({ surface: 'team_process_dialog' });
    expect(blocked.properties).toEqual({ browser_family: 'other', link_origin: 'hosted' });
    expect(blocked.flow_id).toBeNull();
    expect(inconsistency.properties).toEqual({
      link_transport: 'request',
      error_code: 'unauthorized',
      link_stream_open: true
    });
    expect(inconsistency.error_code).toBe('unauthorized');
    expect(pairingStarted.properties).toEqual({ pairing_method: 'fragment' });
    expect(pairingFailed.properties).toEqual({
      pairing_method: 'handshake',
      link_reason: 'pairing_rejected'
    });
    // An unusable duration is clamped, never dropped and never infinite.
    expect(recoveredLater.properties.duration_ms).toBe(0);

    const text = JSON.stringify(delivered.map(event => event.properties));
    expect(text).not.toMatch(/token=|bearer|oauth|authorization|http|nonce|instance_id/i);
  });

  it('drops a value outside its vocabulary and a boolean that is not one', () => {
    expect(
      sanitizeAnalyticsProperties({
        link_trigger: 'wake',
        link_origin: 'staging',
        browser_family: 'opera',
        link_reason: 'cosmic_rays',
        link_stage: 'dns',
        link_transport: 'carrier_pigeon',
        recovery_mode: 'prayer',
        surface: 'settings',
        pairing_method: 'qr',
        instance_changed: 'true',
        token_changed: 1,
        link_stream_open: 'open',
        duration_ms: LINK_DURATION_MAX_MS + 1
      })
    ).toEqual({});
    expect(
      sanitizeAnalyticsProperties({
        link_trigger: 'boot',
        instance_changed: false,
        duration_ms: LINK_DURATION_MAX_MS
      })
    ).toEqual({ link_trigger: 'boot', instance_changed: false, duration_ms: LINK_DURATION_MAX_MS });
  });
});

describe('database guard (real migration body in PGlite)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await PGlite.create();
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).toMatch(
      /create or replace function public\.analytics_properties_are_safe_v2/
    );
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  async function safe(properties: unknown): Promise<boolean> {
    const result = await db.query<{ ok: boolean }>(
      'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
      [JSON.stringify(properties)]
    );
    return result.rows[0]?.ok ?? false;
  }

  it('accepts the properties every helper actually delivers', async () => {
    const delivered = await deliverAll();
    expect(delivered.length).toBeGreaterThan(0);
    for (const event of delivered) {
      expect(await safe(event.properties), event.event_name).toBe(true);
    }
  });

  it('still accepts what it accepted before 032', async () => {
    expect(
      await safe({
        tool_identifier: 'compressor',
        video_count: 3,
        mode: 'optimal',
        retryable: false,
        duration_ms: 5_000,
        flow_id: FLOW
      })
    ).toBe(true);
  });

  it('refuses a value outside a vocabulary, a non-boolean flag and a duration over a day', async () => {
    expect(await safe({ link_trigger: 'wake' })).toBe(false);
    expect(await safe({ link_origin: 'staging' })).toBe(false);
    expect(await safe({ browser_family: 'opera' })).toBe(false);
    expect(await safe({ link_reason: 'cosmic_rays' })).toBe(false);
    expect(await safe({ link_stage: 'dns' })).toBe(false);
    expect(await safe({ link_transport: 'carrier_pigeon' })).toBe(false);
    expect(await safe({ recovery_mode: 'prayer' })).toBe(false);
    expect(await safe({ surface: 'settings' })).toBe(false);
    expect(await safe({ pairing_method: 'qr' })).toBe(false);
    expect(await safe({ instance_changed: 'true' })).toBe(false);
    expect(await safe({ token_changed: 1 })).toBe(false);
    expect(await safe({ link_stream_open: 'open' })).toBe(false);
    // The database bound is the shared sanitizer's one year; the one-day clamp on link
    // events is the client's own.
    expect(await safe({ duration_ms: 31_536_000_001 })).toBe(false);
    expect(await safe({ duration_ms: LINK_DURATION_MAX_MS + 1 })).toBe(true);
    expect(await safe({ duration_ms: '812' })).toBe(false);
    expect(await safe({ link_secret: 'abc' })).toBe(false);
  });
});
