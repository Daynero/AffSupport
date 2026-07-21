import { PRODUCT_VERSION, type ToolContracts } from '@video-compressor/shared';
import { getSupabaseClient } from '../lib/supabase';
import type { Json } from '../lib/database.types';
import {
  analyticsTool,
  isAnalyticsEventName,
  sanitizeAnalyticsProperties,
  type AnalyticsEventName,
  type AnalyticsEventProperties
} from './events';
import { productSessionId } from './session';

const QUEUE_KEY = 'wishly.analytics.queue.v2';
const LEGACY_QUEUE_KEY = 'wishly.analytics.queue.v1';
const INSTALLATION_KEY = 'wishly.analytics.installation.v1';
const MAX_QUEUE_SIZE = 40;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;
const WEB_BUILD_ID = import.meta.env.VITE_WEB_BUILD_ID || PRODUCT_VERSION;
const ANALYTICS_ENABLED = import.meta.env.VITE_ANALYTICS_ENABLED !== 'false';

export type PendingAnalyticsEvent = {
  event_id: string;
  event_name: AnalyticsEventName;
  event_version: number;
  occurred_at: string;
  session_sequence: number;
  user_id: string;
  session_id: string;
  installation_id: string;
  tool: string | null;
  properties: Record<string, Json>;
  web_build_id: string;
  local_app_version: string | null;
  local_app_build: string | null;
  release_channel: string | null;
  core_api_version: number | null;
  tool_contracts: ToolContracts;
  locale: string | null;
  platform: string | null;
  architecture: string | null;
  event_source: 'web';
  flow_id: string | null;
  run_id: string | null;
  feature: string | null;
  screen: string | null;
  action: string | null;
  outcome: string | null;
  error_code: string | null;
  error_stage: string | null;
  error_fingerprint: string | null;
  attempts: number;
};

type AnalyticsSender = (events: PendingAnalyticsEvent[]) => Promise<boolean>;

function uuid() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
    })
  );
}

function readQueue(storage: Storage): PendingAnalyticsEvent[] {
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event): event is PendingAnalyticsEvent => {
        if (!event || typeof event !== 'object') return false;
        const value = event as PendingAnalyticsEvent;
        return (
          isAnalyticsEventName(value.event_name) &&
          typeof value.event_id === 'string' &&
          typeof value.user_id === 'string'
        );
      })
      .map(event => ({ ...event, properties: sanitizeAnalyticsProperties(event.properties) }))
      .slice(-MAX_QUEUE_SIZE);
  } catch {
    return [];
  }
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function installationId(storage: Storage | null) {
  const existing = storage?.getItem(INSTALLATION_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = uuid();
  storage?.setItem(INSTALLATION_KEY, created);
  return created;
}

async function sendWithSupabase(events: PendingAnalyticsEvent[]) {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const payload = events.map(({ attempts: _attempts, ...event }) => event);
  const { data, error } = await supabase.rpc('ingest_analytics_events', {
    p_events: payload as unknown as Json
  });
  if (error) {
    console.warn('Wishly analytics delivery failed.');
    return false;
  }
  return Array.isArray(data) && data.some(result => result.accepted === true);
}

type AgentAnalyticsContext = {
  version: string | null;
  buildId: string | null;
  channel: string | null;
  apiVersion: number | null;
  toolContracts: ToolContracts;
};

export class ProductAnalytics {
  private userId: string | null = null;
  private locale: string | null = null;
  private context: AgentAnalyticsContext = {
    version: null,
    buildId: null,
    channel: null,
    apiVersion: null,
    toolContracts: {}
  };
  private queue: PendingAnalyticsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private sequence = 0;
  private readonly storage: Storage | null;
  private readonly installationId: string;

  constructor(
    private readonly sender: AnalyticsSender = sendWithSupabase,
    storage: Storage | null = defaultStorage()
  ) {
    this.storage = storage;
    this.installationId = installationId(storage);
    if (storage) this.queue = readQueue(storage);
    // Old queue records do not contain the v2 identity envelope. Do not retry
    // them, but remove the legacy copy so unsafe/tampered properties cannot
    // linger indefinitely in browser storage.
    storage?.removeItem(LEGACY_QUEUE_KEY);
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

  setAgentContext(context: AgentAnalyticsContext) {
    this.context = {
      ...context,
      version: context.version?.slice(0, 64) || null,
      buildId: context.buildId?.slice(0, 96) || null,
      channel: context.channel?.slice(0, 32) || null
    };
  }

  track<E extends AnalyticsEventName>(name: E, properties: AnalyticsEventProperties[E]) {
    if (!ANALYTICS_ENABLED || !this.userId || typeof window === 'undefined') return;
    const sanitized = sanitizeAnalyticsProperties(properties);
    const event: PendingAnalyticsEvent = {
      event_id: uuid(),
      event_name: name,
      event_version: 1,
      occurred_at: new Date().toISOString(),
      session_sequence: ++this.sequence,
      user_id: this.userId,
      session_id: productSessionId(),
      installation_id: this.installationId,
      tool: analyticsTool(name, sanitized),
      properties: sanitized,
      web_build_id: WEB_BUILD_ID,
      local_app_version: this.context.version,
      local_app_build: this.context.buildId,
      release_channel: this.context.channel,
      core_api_version: this.context.apiVersion,
      tool_contracts: this.context.toolContracts,
      locale: this.locale,
      platform: analyticsPlatform(),
      architecture: broadArchitecture(),
      event_source: 'web',
      flow_id: safeUuid(sanitized.flow_id),
      run_id: safeUuid(sanitized.run_id),
      feature: safeString(sanitized.feature_identifier),
      screen: safeString(sanitized.screen_identifier),
      action: safeString(sanitized.action_identifier),
      outcome: safeString(sanitized.outcome),
      error_code: safeString(sanitized.error_code ?? sanitized.error_category),
      error_stage: safeString(sanitized.error_stage),
      error_fingerprint: safeString(sanitized.error_fingerprint),
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
      else this.retry(batch);
      this.persist();
    } catch {
      this.retry(batch);
      this.persist();
    } finally {
      this.flushing = false;
    }
  }

  pendingCount() {
    return this.queue.length;
  }

  private retry(batch: PendingAnalyticsEvent[]) {
    const attempted = new Set(batch.map(event => event.event_id));
    this.queue = this.queue
      .map(event =>
        attempted.has(event.event_id) ? { ...event, attempts: event.attempts + 1 } : event
      )
      .filter(event => event.attempts < MAX_ATTEMPTS);
  }

  private scheduleFlush() {
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1200);
  }

  private persist() {
    this.storage?.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(-MAX_QUEUE_SIZE)));
  }
}

// Analytics may keep a coarse platform cohort, but this value must never gate
// which installer choices the interface shows.
function analyticsPlatform() {
  if (typeof navigator === 'undefined') return null;
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes('mac')) return 'macos';
  if (value.includes('win')) return 'windows';
  if (value.includes('linux')) return 'linux';
  return 'other';
}

function broadArchitecture() {
  if (typeof navigator === 'undefined') return null;
  return /arm64|aarch64/i.test(navigator.userAgent)
    ? 'arm64'
    : /x86_64|win64|x64/i.test(navigator.userAgent)
      ? 'x64'
      : 'unknown';
}

function safeString(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function safeUuid(value: Json | undefined): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export const analytics = new ProductAnalytics();
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void analytics.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void analytics.flush();
  });
}
