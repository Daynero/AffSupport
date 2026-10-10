import { DIAGNOSTIC_CATEGORIES, type DiagnosticRecord } from '@video-compressor/shared';
import { getSupabaseClient } from '../lib/supabase';
import type { AgentDiagnosticsResponse } from '../support/diagnostics-bundle';

/**
 * 033 US2 / FR-003 — forwards the agent's diagnostic journal to the database.
 *
 * The agent keeps its journal on the user's machine; without this, a developer
 * investigating a complaint sees nothing of what the agent recorded unless the
 * user copies a support bundle. On a handful of triggers (a successful link
 * check, an `error_occurred`, a recovered link, a failed tool readiness, the
 * tab being hidden) the web reads the journal from the last forwarded `seq`
 * and hands it to `ingest_agent_journal`, which repeats the privacy fence on
 * the server.
 *
 * Rules: never more than one run per 30 seconds (a trigger inside the window
 * schedules exactly one trailing run); at most five pages of 200 records per
 * run; the cursor `{ instanceId, seq }` in localStorage moves only after the
 * server answered; a new agent instance starts from 0. Nothing here throws or
 * blocks the caller: any failure ends the run silently and the next trigger
 * resumes from the cursor.
 *
 * `api/client` is imported lazily by the default instance only. `service.ts`
 * imports this module and is itself imported almost everywhere, including
 * node-environment tests that must not load the browser API client.
 */

export const JOURNAL_CURSOR_KEY = 'wishly.agent-journal.cursor.v1';
export const JOURNAL_PAGE_SIZE = 200;
export const JOURNAL_MAX_PAGES = 5;
export const JOURNAL_MIN_INTERVAL_MS = 30_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const PROP_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u;
const MAX_PROPS = 16;
const MAX_STRING_LENGTH = 64;
const MAX_FUTURE_MS = 86_400_000;
/** The server's list (`ingest_agent_journal`), which the agent's now matches. */
const FORBIDDEN_FRAGMENTS = ['/', '\\', '://', 'token', 'bearer', '@'];
/**
 * The agent's file-name shapes (`diagnostics-log.ts`), repeated so a record from an agent
 * older than that fence still never carries `holiday.mov` off the machine (SC-009).
 */
const FILE_NAME_SHAPES = [/\s/u, /\.[a-z0-9]*[a-z][a-z0-9]*$/iu];
const CATEGORIES: ReadonlySet<string> = new Set(DIAGNOSTIC_CATEGORIES);

export interface JournalForwarderContext {
  /** Analytics is on for this build and a user is signed in. */
  enabled: boolean;
  installationId: string | null;
  /** The agent's per-boot instance id; nothing is forwarded until it is known. */
  instanceId: string | null;
}

export interface JournalIngestResult {
  accepted: number;
  duplicates: number;
  rejected: { seq: number | null; reason: string }[];
}

export interface JournalSendInput {
  installationId: string | null;
  instanceId: string;
  records: DiagnosticRecord[];
}

export interface JournalForwarderDeps {
  fetchPage: (since: number, limit: number) => Promise<AgentDiagnosticsResponse>;
  send: (input: JournalSendInput) => Promise<JournalIngestResult>;
  storage: Storage | null;
  context: () => JournalForwarderContext;
  now?: () => number;
  /** Extra gate on top of `context().enabled`; the build-level analytics switch. */
  enabled?: () => boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface JournalForwarder {
  /** Never rejects; resolves when the run this trigger started (if any) is over. */
  forward(trigger: string): Promise<void>;
}

interface JournalCursor {
  instanceId: string;
  seq: number;
}

/** Whether a tracked analytics event is one of the FR-003 triggers. */
export function forwardsAgentJournal(name: string, properties: unknown): boolean {
  const outcome =
    properties && typeof properties === 'object'
      ? (properties as Record<string, unknown>).outcome
      : undefined;
  switch (name) {
    case 'link_check_completed':
      return outcome === 'success';
    case 'tool_ready':
      return outcome === 'failure';
    case 'error_occurred':
    case 'link_recovered':
      return true;
    default:
      return false;
  }
}

function isSafeValue(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_STRING_LENGTH) return false;
  const lowered = value.toLowerCase();
  if (FORBIDDEN_FRAGMENTS.some(fragment => lowered.includes(fragment))) return false;
  return !FILE_NAME_SHAPES.some(shape => shape.test(value));
}

/**
 * The server fence, applied before sending (FR-011): a record the server would
 * refuse is never put on the wire. Exported for the privacy test.
 */
export function isForwardableRecord(record: unknown, now: number = Date.now()): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const { seq, at, category, code, props } = record as Record<string, unknown>;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return false;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false;
  if (at > now + MAX_FUTURE_MS) return false;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) return false;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return false;
  if (props === undefined || props === null) return true;
  if (typeof props !== 'object' || Array.isArray(props)) return false;
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > MAX_PROPS) return false;
  return entries.every(([key, value]) => PROP_KEY_PATTERN.test(key) && isSafeValue(value));
}

/** Only the fields the server reads; nothing else of the record leaves the browser. */
function wireRecord(record: DiagnosticRecord): DiagnosticRecord {
  const wire: DiagnosticRecord = {
    seq: record.seq,
    at: record.at,
    category: record.category,
    code: record.code
  };
  if (record.props && Object.keys(record.props).length > 0) wire.props = { ...record.props };
  return wire;
}

function safeUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function readCursor(storage: Storage | null): JournalCursor | null {
  try {
    const raw = storage?.getItem(JOURNAL_CURSOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JournalCursor> | null;
    const instanceId = safeUuid(parsed?.instanceId);
    const seq = parsed?.seq;
    if (!instanceId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      return null;
    }
    return { instanceId, seq };
  } catch {
    return null;
  }
}

function writeCursor(storage: Storage | null, cursor: JournalCursor): void {
  storage?.setItem(JOURNAL_CURSOR_KEY, JSON.stringify(cursor));
}

function isIngestResult(value: unknown): value is JournalIngestResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.accepted === 'number' &&
    typeof result.duplicates === 'number' &&
    Array.isArray(result.rejected)
  );
}

export function createJournalForwarder(deps: JournalForwarderDeps): JournalForwarder {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  let running = false;
  let trailing = false;
  let timer: unknown = null;
  let lastRunAt: number | null = null;

  function readyInstance(): { installationId: string | null; instanceId: string } | null {
    if (deps.enabled && !deps.enabled()) return null;
    const context = deps.context();
    if (!context.enabled) return null;
    const instanceId = safeUuid(context.instanceId);
    if (!instanceId) return null;
    return { installationId: safeUuid(context.installationId), instanceId };
  }

  function scheduleTrailing(delayMs: number): void {
    if (timer !== null) return;
    timer = schedule(
      () => {
        timer = null;
        void forward('trailing');
      },
      Math.max(0, delayMs)
    );
  }

  async function drain(target: { installationId: string | null; instanceId: string }) {
    const { installationId, instanceId } = target;
    const stored = readCursor(deps.storage);
    // A different agent instance numbers its journal afresh, so its cursor starts at 0.
    const previous = stored && stored.instanceId !== instanceId ? stored : null;
    let since = stored && stored.instanceId === instanceId ? stored.seq : 0;

    for (let page = 0; page < JOURNAL_MAX_PAGES; page += 1) {
      const response = await deps.fetchPage(since, JOURNAL_PAGE_SIZE);
      // An agent older than the journal answers without `log`; nothing to forward.
      if (!response || !Array.isArray(response.log)) return;
      // The agent restarted since the context was read: the next trigger starts it properly.
      const answeredBy = safeUuid(response.instanceId);
      if (answeredBy && answeredBy !== instanceId) return;
      const log = response.log.filter(
        record =>
          record &&
          typeof record.seq === 'number' &&
          Number.isSafeInteger(record.seq) &&
          record.seq > since
      );
      if (log.length === 0) return;

      const startedAt = typeof response.startedAt === 'number' ? response.startedAt : null;
      const at = now();
      const records = log
        .filter(record => isForwardableRecord(record, at))
        // The journal file carries the previous boot's tail into this one. Records the
        // previous instance already forwarded are not sent again under the new id.
        .filter(
          record =>
            !(previous && startedAt !== null && record.seq <= previous.seq && record.at < startedAt)
        )
        .map(wireRecord);
      const lastSeq = log.reduce((highest, record) => Math.max(highest, record.seq), since);

      if (records.length > 0) {
        const result = await deps.send({ installationId, instanceId, records });
        if (!isIngestResult(result)) return;
      }
      since = lastSeq;
      writeCursor(deps.storage, { instanceId, seq: since });
      if (response.log.length < JOURNAL_PAGE_SIZE) return;
    }
  }

  async function run(target: { installationId: string | null; instanceId: string }) {
    running = true;
    lastRunAt = now();
    try {
      await drain(target);
    } catch {
      // Diagnostics about diagnostics are not worth a user-visible failure; the cursor did
      // not move, so the next trigger retries the same page.
    } finally {
      running = false;
      if (trailing) {
        trailing = false;
        scheduleTrailing(lastRunAt + JOURNAL_MIN_INTERVAL_MS - now());
      }
    }
  }

  async function forward(_trigger: string): Promise<void> {
    try {
      const target = readyInstance();
      if (!target) return;
      if (running) {
        trailing = true;
        return;
      }
      const wait = lastRunAt === null ? 0 : lastRunAt + JOURNAL_MIN_INTERVAL_MS - now();
      if (wait > 0) {
        scheduleTrailing(wait);
        return;
      }
      await run(target);
    } catch {
      // Never into the caller.
    }
  }

  return { forward };
}

/* ---------------------------------------------------------------------------
 * The default instance. Its context comes from `ProductAnalytics` through
 * `bindJournalContext`, so this module never imports the service (which
 * imports it).
 * ------------------------------------------------------------------------- */

let contextSource: () => JournalForwarderContext = () => ({
  enabled: false,
  installationId: null,
  instanceId: null
});

export function bindJournalContext(source: () => JournalForwarderContext): void {
  contextSource = source;
}

type UntypedRpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

async function sendWithSupabase(input: JournalSendInput): Promise<JournalIngestResult> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  // `ingest_agent_journal` (20261124100000) is not in the generated types yet.
  const { data, error } = await (supabase as unknown as UntypedRpcClient).rpc(
    'ingest_agent_journal',
    {
      p_installation_id: input.installationId,
      p_agent_instance_id: input.instanceId,
      p_records: input.records
    }
  );
  if (error) throw new Error(error.code || 'AGENT_JOURNAL_INGEST_FAILED');
  if (!isIngestResult(data)) throw new Error('AGENT_JOURNAL_INGEST_MALFORMED');
  return data;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const journalForwarder: JournalForwarder = createJournalForwarder({
  fetchPage: async (since, limit) => {
    const { fetchAgentDiagnostics } = await import('../api/client');
    return fetchAgentDiagnostics(since, limit);
  },
  send: sendWithSupabase,
  storage: defaultStorage(),
  context: () => contextSource()
});
