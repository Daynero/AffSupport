import { PRODUCT_VERSION } from '@video-compressor/shared';
import type { Json } from '../lib/database.types';
import { getSupabaseClient } from '../lib/supabase';
import {
  analyticsTool,
  isAnalyticsEventName,
  sanitizeAnalyticsProperties,
  type AnalyticsEventName,
  type AnalyticsEventProperties
} from './events';
import { productSessionId } from './session';

const QUEUE_KEY = 'wishly.analytics.queue.v1';
const MAX_QUEUE_SIZE = 40;
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;

export type PendingAnalyticsEvent = {
  event_name: AnalyticsEventName;
  user_id: string;
  session_id: string;
  tool: string | null;
  properties: Record<string, Json>;
  app_version: string;
  agent_version: string | null;
  locale: string | null;
  platform: string | null;
  attempts: number;
};

type AnalyticsSender = (events: PendingAnalyticsEvent[]) => Promise<boolean>;

function readQueue(storage: Storage): PendingAnalyticsEvent[] {
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event): event is PendingAnalyticsEvent => {
        if (!event || typeof event !== 'object') return false;
        const candidate = event as PendingAnalyticsEvent;
        return (
          isAnalyticsEventName(candidate.event_name) &&
          typeof candidate.user_id === 'string' &&
          /^[0-9a-f-]{36}$/i.test(candidate.user_id) &&
          typeof candidate.session_id === 'string' &&
          /^[0-9a-f-]{36}$/i.test(candidate.session_id)
        );
      })
      .map(event => {
        const properties = sanitizeAnalyticsProperties(event.properties);
        return {
          event_name: event.event_name,
          user_id: event.user_id,
          session_id: event.session_id,
          tool: analyticsTool(event.event_name, properties),
          properties,
          app_version: PRODUCT_VERSION,
          agent_version:
            typeof event.agent_version === 'string' ? event.agent_version.slice(0, 64) : null,
          locale: event.locale === 'en' || event.locale === 'uk' ? event.locale : null,
          platform: ['macos', 'windows', 'linux', 'other'].includes(event.platform ?? '')
            ? event.platform
            : null,
          attempts:
            Number.isInteger(event.attempts) && event.attempts >= 0
              ? Math.min(event.attempts, MAX_ATTEMPTS)
              : 0
        };
      })
      .slice(-MAX_QUEUE_SIZE);
  } catch {
    return [];
  }
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

async function sendWithSupabase(events: PendingAnalyticsEvent[]) {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase
    .from('analytics_events')
    .insert(events.map(({ attempts: _attempts, ...event }) => event));
  if (error) {
    console.warn('Wishly analytics delivery failed.');
    return false;
  }
  return true;
}

export class ProductAnalytics {
  private userId: string | null = null;
  private locale: string | null = null;
  private agentVersion: string | null = null;
  private platform: string | null = null;
  private queue: PendingAnalyticsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private readonly storage: Storage | null;

  constructor(
    private readonly sender: AnalyticsSender = sendWithSupabase,
    storage: Storage | null = defaultStorage()
  ) {
    this.storage = storage;
    if (storage) {
      this.queue = readQueue(storage);
      this.persist();
    }
  }

  setUser(userId: string | null) {
    if (userId) this.queue = this.queue.filter(event => event.user_id === userId);
    else if (this.userId) this.queue = [];
    this.userId = userId;
    this.persist();
  }

  setLocale(locale: string | null) {
    this.locale = locale === 'en' || locale === 'uk' ? locale : null;
  }

  setAgentContext(version: string | null, platform: string | null) {
    this.agentVersion = version?.slice(0, 64) || null;
    this.platform = ['macos', 'windows', 'linux', 'other'].includes(platform ?? '')
      ? platform
      : null;
  }

  track<E extends AnalyticsEventName>(name: E, properties: AnalyticsEventProperties[E]) {
    if (!this.userId || typeof window === 'undefined') return;
    const sanitized = sanitizeAnalyticsProperties(properties);
    const event: PendingAnalyticsEvent = {
      event_name: name,
      user_id: this.userId,
      session_id: productSessionId(),
      tool: analyticsTool(name, sanitized),
      properties: sanitized,
      app_version: PRODUCT_VERSION,
      agent_version: this.agentVersion,
      locale: this.locale,
      platform: this.platform,
      attempts: 0
    };
    this.queue = [...this.queue, event].slice(-MAX_QUEUE_SIZE);
    this.persist();
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else this.scheduleFlush();
  }

  async flush() {
    if (this.flushing || !this.queue.length || !this.userId) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    this.flushing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.slice(0, BATCH_SIZE).filter(event => event.user_id === this.userId);
    try {
      const delivered = batch.length > 0 && (await this.sender(batch));
      if (delivered) this.queue.splice(0, batch.length);
      else {
        const attempted = new Set(batch);
        this.queue = this.queue
          .map(event => (attempted.has(event) ? { ...event, attempts: event.attempts + 1 } : event))
          .filter(event => event.attempts < MAX_ATTEMPTS);
      }
      this.persist();
    } catch {
      console.warn('Wishly analytics delivery failed.');
      this.queue = this.queue
        .map((event, index) =>
          index < batch.length ? { ...event, attempts: event.attempts + 1 } : event
        )
        .filter(event => event.attempts < MAX_ATTEMPTS);
      this.persist();
    } finally {
      this.flushing = false;
    }
  }

  pendingCount() {
    return this.queue.length;
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 1200);
  }

  private persist() {
    this.storage?.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(-MAX_QUEUE_SIZE)));
  }
}

export const analytics = new ProductAnalytics();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void analytics.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void analytics.flush();
  });
}
