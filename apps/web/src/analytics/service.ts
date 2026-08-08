import {
  PRODUCT_VERSION,
  type MaterialCategory,
  type TeamAnalyticsAction,
  type TeamAnalyticsCacheState,
  type TeamAnalyticsCue,
  type TeamAnalyticsOutcome,
  type TeamAnalyticsSizeBucket,
  type TeamAnalyticsStage,
  type TeamAnalyticsStorage,
  type ToolContracts
} from '@video-compressor/shared';
import { getSupabaseClient } from '../lib/supabase';
import type { Json } from '../lib/database.types';
import { currentBrowserPlatform } from '../lib/platform';
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

export type AnalyticsDeliveryResult =
  | boolean
  | {
      acceptedEventIds: string[];
    };

type AnalyticsSender = (events: PendingAnalyticsEvent[]) => Promise<AnalyticsDeliveryResult>;

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
      .map(event => ({
        ...event,
        properties: sanitizeAnalyticsProperties(event.properties, event.event_name)
      }))
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
    console.warn('Soty analytics delivery failed.', {
      code: error.code,
      message: error.message
    });
    return false;
  }
  if (!Array.isArray(data)) return false;

  const batchIds = new Set(events.map(event => event.event_id));
  const acceptedEventIds = data
    .filter(result => result.accepted === true && batchIds.has(result.event_id))
    .map(result => result.event_id);
  const rejected = data.filter(result => result.accepted !== true && batchIds.has(result.event_id));
  if (rejected.length) {
    console.warn(
      'Soty analytics rejected events.',
      rejected.map(result => ({ event_id: result.event_id, reason: result.reason }))
    );
  }
  return { acceptedEventIds };
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
    const sanitized = sanitizeAnalyticsProperties(properties, name);
    const eventProperties = { ...sanitized };
    delete eventProperties.flow_id;
    delete eventProperties.run_id;
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
      properties: eventProperties,
      web_build_id: WEB_BUILD_ID,
      local_app_version: this.context.version,
      local_app_build: this.context.buildId,
      release_channel: this.context.channel,
      core_api_version: this.context.apiVersion,
      tool_contracts: this.context.toolContracts,
      locale: this.locale,
      platform: currentBrowserPlatform(),
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
      const result = batch.length > 0 ? await this.sender(batch) : false;
      if (result === true) {
        this.remove(batch);
      } else if (result === false) {
        this.retry(batch);
      } else {
        const accepted = new Set(result.acceptedEventIds);
        this.remove(batch.filter(event => accepted.has(event.event_id)));
        this.retry(batch.filter(event => !accepted.has(event.event_id)));
      }
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

  private remove(batch: PendingAnalyticsEvent[]) {
    const delivered = new Set(batch.map(event => event.event_id));
    this.queue = this.queue.filter(event => !delivered.has(event.event_id));
  }

  private scheduleFlush() {
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1200);
  }

  private persist() {
    this.storage?.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(-MAX_QUEUE_SIZE)));
  }
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

type AnalyticsTracker = Pick<ProductAnalytics, 'track'>;

export function trackTeamWorkspaceSession(tracker: AnalyticsTracker = analytics): void {
  tracker.track('team_workspace_session', { workspace_session: true });
}

export interface TeamFileAttemptFlow {
  attemptId: string;
  action: TeamAnalyticsAction;
  storageKind: TeamAnalyticsStorage;
  sizeBucket: TeamAnalyticsSizeBucket;
  cacheState: TeamAnalyticsCacheState;
  attemptNumber: number;
  startedAt: number;
  completed: boolean;
}

export interface TeamWorkflowFlow {
  workflowId: string;
  category: MaterialCategory;
  cacheState: TeamAnalyticsCacheState;
  attemptNumber: number;
  startedAt: number;
  completed: boolean;
}

interface TeamAnalyticsLifecycleOptions {
  now?: number;
  tracker?: AnalyticsTracker;
}

export function teamAnalyticsSizeBucket(
  sizeBytes: number | null | undefined
): TeamAnalyticsSizeBucket {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return 'agent';
  if (sizeBytes <= 1024 * 1024) return 'tiny';
  if (sizeBytes <= 10 * 1024 * 1024) return 'small';
  if (sizeBytes <= 32 * 1024 * 1024) return 'medium';
  if (sizeBytes <= 100 * 1024 * 1024) return 'large';
  return 'agent';
}

export function startTeamFileAttempt(
  input: {
    action: TeamAnalyticsAction;
    storageKind: TeamAnalyticsStorage;
    sizeBucket: TeamAnalyticsSizeBucket;
    cacheState?: TeamAnalyticsCacheState;
    attemptNumber?: number;
    stage?: TeamAnalyticsStage;
  },
  options: TeamAnalyticsLifecycleOptions = {}
): TeamFileAttemptFlow {
  const flow: TeamFileAttemptFlow = {
    attemptId: uuid(),
    action: input.action,
    storageKind: input.storageKind,
    sizeBucket: input.sizeBucket,
    cacheState: input.cacheState ?? 'unknown',
    attemptNumber: boundedAttemptNumber(input.attemptNumber),
    startedAt: options.now ?? Date.now(),
    completed: false
  };
  (options.tracker ?? analytics).track('team_file_attempt_started', {
    attempt_id: flow.attemptId,
    action: flow.action,
    storage_kind: flow.storageKind,
    size_bucket: flow.sizeBucket,
    cache_state: flow.cacheState,
    attempt_number: flow.attemptNumber,
    stage: input.stage ?? stageForFileAction(flow.action)
  });
  return flow;
}

export function completeTeamFileAttempt(
  flow: TeamFileAttemptFlow,
  result: {
    outcome: TeamAnalyticsOutcome;
    retryable: boolean;
    stage?: TeamAnalyticsStage;
  },
  options: TeamAnalyticsLifecycleOptions = {}
): void {
  if (flow.completed) return;
  flow.completed = true;
  (options.tracker ?? analytics).track('team_file_attempt_completed', {
    attempt_id: flow.attemptId,
    action: flow.action,
    storage_kind: flow.storageKind,
    size_bucket: flow.sizeBucket,
    cache_state: flow.cacheState,
    attempt_number: flow.attemptNumber,
    duration_ms: boundedDuration(flow.startedAt, options.now ?? Date.now()),
    stage: result.stage ?? stageForFileAction(flow.action),
    outcome: result.outcome,
    retryable: result.retryable,
    production_completed: result.outcome === 'success'
  });
}

export function startTeamWorkflow(
  input: {
    category: MaterialCategory;
    cacheState?: TeamAnalyticsCacheState;
    attemptNumber?: number;
    stage?: TeamAnalyticsStage;
  },
  options: TeamAnalyticsLifecycleOptions = {}
): TeamWorkflowFlow {
  const flow: TeamWorkflowFlow = {
    workflowId: uuid(),
    category: input.category,
    cacheState: input.cacheState ?? 'unknown',
    attemptNumber: boundedAttemptNumber(input.attemptNumber),
    startedAt: options.now ?? Date.now(),
    completed: false
  };
  (options.tracker ?? analytics).track('team_workflow_started', {
    workflow_id: flow.workflowId,
    category: flow.category,
    cache_state: flow.cacheState,
    attempt_number: flow.attemptNumber,
    stage: input.stage ?? 'downloading'
  });
  return flow;
}

export function completeTeamWorkflow(
  flow: TeamWorkflowFlow,
  result: {
    outcome: TeamAnalyticsOutcome;
    retryable: boolean;
    stage?: TeamAnalyticsStage;
  },
  options: TeamAnalyticsLifecycleOptions = {}
): void {
  if (flow.completed) return;
  flow.completed = true;
  (options.tracker ?? analytics).track('team_workflow_completed', {
    workflow_id: flow.workflowId,
    category: flow.category,
    cache_state: flow.cacheState,
    attempt_number: flow.attemptNumber,
    duration_ms: boundedDuration(flow.startedAt, options.now ?? Date.now()),
    stage: result.stage ?? 'finalizing',
    outcome: result.outcome,
    retryable: result.retryable,
    production_completed: result.outcome === 'success'
  });
}

function boundedAttemptNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), 10_000)
    : 1;
}

function boundedDuration(startedAt: number, completedAt: number): number {
  return Math.min(Math.max(Math.round(completedAt - startedAt), 0), 31_536_000_000);
}

function stageForFileAction(action: TeamAnalyticsAction): TeamAnalyticsStage {
  if (action === 'download') return 'downloading';
  if (action === 'upload') return 'uploading';
  return 'finalizing';
}

export interface TeamOnboardingFlow {
  flowId: string;
  startedAt: number;
  completed: boolean;
}

export function startTeamOnboardingFlow(now = Date.now()): TeamOnboardingFlow {
  const flow = { flowId: uuid(), startedAt: now, completed: false };
  analytics.track('team_onboarding_started', { flow_id: flow.flowId });
  return flow;
}

export function completeTeamOnboardingFlow(
  flow: TeamOnboardingFlow,
  result: {
    invitePersisted: boolean;
    rootConfirmed: boolean;
    syncQueued: boolean;
    outcome: 'success' | 'failure' | 'cancelled' | 'blocked';
  },
  now = Date.now()
): void {
  if (flow.completed) return;
  flow.completed = true;
  analytics.track('team_onboarding_completed', {
    flow_id: flow.flowId,
    duration_ms: Math.max(0, now - flow.startedAt),
    invite_persisted: result.invitePersisted,
    root_confirmed: result.rootConfirmed,
    sync_queued: result.syncQueued,
    outcome: result.outcome
  });
}

export interface TeamFindFlow {
  studyRunId: string;
  attemptId: string;
  cueCategory: TeamAnalyticsCue;
  startedAt: number;
  completed: boolean;
}

export function startTeamFindFlow(
  cueCategory: TeamAnalyticsCue,
  options: { studyRunId?: string; now?: number } = {}
): TeamFindFlow {
  const flow = {
    studyRunId: options.studyRunId ?? uuid(),
    attemptId: uuid(),
    cueCategory,
    startedAt: options.now ?? Date.now(),
    completed: false
  };
  analytics.track('team_find_started', {
    study_run_id: flow.studyRunId,
    attempt_id: flow.attemptId,
    cue_category: flow.cueCategory,
    stage: 'finding'
  });
  return flow;
}

export function completeTeamFindFlow(
  flow: TeamFindFlow,
  result: { outcome: TeamAnalyticsOutcome; assisted: boolean },
  now = Date.now()
): void {
  if (flow.completed) return;
  flow.completed = true;
  analytics.track('team_find_completed', {
    study_run_id: flow.studyRunId,
    attempt_id: flow.attemptId,
    cue_category: flow.cueCategory,
    duration_ms: Math.max(0, now - flow.startedAt),
    outcome: result.outcome,
    assisted: result.assisted,
    stage: 'finding'
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void analytics.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void analytics.flush();
  });
}
