// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticRecord } from '@video-compressor/shared';
import {
  journalForwarder,
  JOURNAL_CURSOR_KEY,
  JOURNAL_MIN_INTERVAL_MS,
  JOURNAL_PAGE_SIZE,
  createJournalForwarder,
  forwardsAgentJournal,
  isForwardableRecord,
  type JournalForwarderContext,
  type JournalSendInput
} from '../apps/web/src/analytics/journal-forwarder';
import { ProductAnalytics, analytics } from '../apps/web/src/analytics/service';
import type { AgentDiagnosticsResponse } from '../apps/web/src/support/diagnostics-bundle';

/**
 * 033 US2 / FR-003, FR-011 — the web side of the agent journal: which events
 * trigger a forward, the 30-second debounce with one trailing run, the cursor
 * per agent instance, paging, and the client-side privacy fence.
 */

const INSTANCE = '33000000-0000-4000-8000-0000000000b1';
const RESTARTED = '33000000-0000-4000-8000-0000000000b2';
const INSTALLATION = '33000000-0000-4000-8000-0000000000a1';
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

function journal(count: number, from = 1, at = T0 - 60_000): DiagnosticRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: from + index,
    at,
    category: 'spawn' as const,
    code: 'exit_nonzero',
    props: { duration: 'under_10s' }
  }));
}

interface Harness {
  forwarder: ReturnType<typeof createJournalForwarder>;
  storage: MemoryStorage;
  sent: JournalSendInput[];
  fetches: number[];
  clock: { now: number };
  context: JournalForwarderContext;
  timers: { callback: () => void; at: number }[];
  runTimers: () => Promise<void>;
  setJournal: (records: DiagnosticRecord[], extra?: Partial<AgentDiagnosticsResponse>) => void;
  send: ReturnType<typeof vi.fn>;
  fetchPage: ReturnType<typeof vi.fn>;
}

function harness(options: { analyticsOn?: boolean } = {}): Harness {
  const storage = new MemoryStorage();
  const sent: JournalSendInput[] = [];
  const fetches: number[] = [];
  const clock = { now: T0 };
  const context: JournalForwarderContext = {
    enabled: true,
    installationId: INSTALLATION,
    instanceId: INSTANCE
  };
  const timers: { callback: () => void; at: number }[] = [];
  let records: DiagnosticRecord[] = [];
  let extra: Partial<AgentDiagnosticsResponse> = {};

  const fetchPage = vi.fn(async (since: number, limit: number) => {
    fetches.push(since);
    const log = records.filter(record => record.seq > since).slice(0, limit);
    return {
      instanceId: context.instanceId ?? undefined,
      log,
      nextSeq: log.at(-1)?.seq ?? since,
      ...extra
    } satisfies AgentDiagnosticsResponse;
  });
  const send = vi.fn(async (input: JournalSendInput) => {
    sent.push(input);
    return { accepted: input.records.length, duplicates: 0, rejected: [] };
  });

  const forwarder = createJournalForwarder({
    fetchPage,
    send,
    storage,
    context: () => context,
    now: () => clock.now,
    enabled: () => options.analyticsOn ?? true,
    schedule: (callback, delayMs) => {
      timers.push({ callback, at: clock.now + delayMs });
      return timers.length;
    }
  });

  return {
    forwarder,
    storage,
    sent,
    fetches,
    clock,
    context,
    timers,
    send,
    fetchPage,
    setJournal: (next, nextExtra = {}) => {
      records = next;
      extra = nextExtra;
    },
    runTimers: async () => {
      const due = timers.splice(0);
      for (const timer of due) {
        clock.now = Math.max(clock.now, timer.at);
        timer.callback();
      }
      // Let the run the timer started finish.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
}

function cursor(storage: Storage) {
  const raw = storage.getItem(JOURNAL_CURSOR_KEY);
  return raw ? (JSON.parse(raw) as { instanceId: string; seq: number }) : null;
}

describe('which analytics events trigger a forward', () => {
  it('maps the FR-003 triggers and nothing else', () => {
    expect(forwardsAgentJournal('link_check_completed', { outcome: 'success' })).toBe(true);
    expect(forwardsAgentJournal('link_check_completed', { outcome: 'failure' })).toBe(false);
    expect(forwardsAgentJournal('tool_ready', { outcome: 'failure' })).toBe(true);
    expect(forwardsAgentJournal('tool_ready', { outcome: 'success' })).toBe(false);
    expect(forwardsAgentJournal('error_occurred', {})).toBe(true);
    expect(forwardsAgentJournal('link_recovered', undefined)).toBe(true);
    expect(forwardsAgentJournal('compression_completed', { outcome: 'success' })).toBe(false);
  });
});

describe('journal forwarder', () => {
  it('sends the new records once and moves the cursor', async () => {
    const h = harness();
    h.setJournal(journal(3));
    await h.forwarder.forward('error_occurred');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ installationId: INSTALLATION, instanceId: INSTANCE });
    expect(h.sent[0]!.records.map(record => record.seq)).toEqual([1, 2, 3]);
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 3 });
  });

  it('runs at most once per 30 s and schedules exactly one trailing run', async () => {
    const h = harness();
    h.setJournal(journal(2));
    await h.forwarder.forward('error_occurred');
    h.setJournal(journal(4));
    h.clock.now += 1_000;
    await h.forwarder.forward('link_recovered');
    await h.forwarder.forward('tool_ready');
    await h.forwarder.forward('visibility_hidden');
    expect(h.sent).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.at).toBe(T0 + JOURNAL_MIN_INTERVAL_MS);

    await h.runTimers();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.records.map(record => record.seq)).toEqual([3, 4]);
    expect(h.fetches).toEqual([0, 2]);
    expect(h.timers).toHaveLength(0);
  });

  it('a trigger during a run leads to one trailing run after the window', async () => {
    const h = harness();
    h.setJournal(journal(1));
    let release: () => void = () => undefined;
    h.send.mockImplementationOnce(async (input: JournalSendInput) => {
      h.sent.push(input);
      await new Promise<void>(resolve => (release = resolve));
      return { accepted: 1, duplicates: 0, rejected: [] };
    });
    const first = h.forwarder.forward('error_occurred');
    await new Promise(resolve => setTimeout(resolve, 0));
    await h.forwarder.forward('link_recovered');
    expect(h.timers).toHaveLength(0);
    release();
    await first;
    expect(h.timers).toHaveLength(1);
  });

  it('runs again without a timer once the window has passed', async () => {
    const h = harness();
    h.setJournal(journal(1));
    await h.forwarder.forward('error_occurred');
    h.setJournal(journal(2));
    h.clock.now += JOURNAL_MIN_INTERVAL_MS;
    await h.forwarder.forward('error_occurred');
    expect(h.sent).toHaveLength(2);
    expect(h.timers).toHaveLength(0);
  });

  it('does not move the cursor when the RPC fails, and swallows the error', async () => {
    const h = harness();
    h.setJournal(journal(2));
    h.send.mockRejectedValueOnce(new Error('PGRST301'));
    await expect(h.forwarder.forward('error_occurred')).resolves.toBeUndefined();
    expect(cursor(h.storage)).toBeNull();

    h.clock.now += JOURNAL_MIN_INTERVAL_MS;
    await h.forwarder.forward('error_occurred');
    expect(h.sent.map(input => input.records.map(record => record.seq))).toEqual([[1, 2]]);
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 2 });
  });

  it('does not move the cursor on a malformed answer', async () => {
    const h = harness();
    h.setJournal(journal(2));
    h.send.mockResolvedValueOnce(null as never);
    await h.forwarder.forward('error_occurred');
    expect(cursor(h.storage)).toBeNull();
  });

  it('swallows a failing agent read', async () => {
    const h = harness();
    h.fetchPage.mockRejectedValueOnce(new Error('CONNECTION_FAILED'));
    await expect(h.forwarder.forward('error_occurred')).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(0);
  });

  it('advances past records the server rejected', async () => {
    const h = harness();
    h.setJournal(journal(2));
    h.send.mockResolvedValueOnce({
      accepted: 1,
      duplicates: 0,
      rejected: [{ seq: 2, reason: 'invalid_code' }]
    });
    await h.forwarder.forward('error_occurred');
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 2 });
  });

  it('resumes from the stored cursor of the same instance', async () => {
    const h = harness();
    h.storage.setItem(JOURNAL_CURSOR_KEY, JSON.stringify({ instanceId: INSTANCE, seq: 5 }));
    h.setJournal(journal(7));
    await h.forwarder.forward('error_occurred');
    expect(h.fetches[0]).toBe(5);
    expect(h.sent[0]!.records.map(record => record.seq)).toEqual([6, 7]);
  });

  it('starts from 0 for a new agent instance', async () => {
    const h = harness();
    h.storage.setItem(JOURNAL_CURSOR_KEY, JSON.stringify({ instanceId: INSTANCE, seq: 50 }));
    h.context.instanceId = RESTARTED;
    h.setJournal(journal(3), { startedAt: T0 - 120_000 });
    await h.forwarder.forward('link_check_completed');
    expect(h.fetches[0]).toBe(0);
    expect(h.sent[0]!.instanceId).toBe(RESTARTED);
    expect(h.sent[0]!.records.map(record => record.seq)).toEqual([1, 2, 3]);
    expect(cursor(h.storage)).toEqual({ instanceId: RESTARTED, seq: 3 });
  });

  it('does not resend the previous boot’s tail under a new instance', async () => {
    const h = harness();
    h.storage.setItem(JOURNAL_CURSOR_KEY, JSON.stringify({ instanceId: INSTANCE, seq: 2 }));
    h.context.instanceId = RESTARTED;
    const startedAt = T0 - 30_000;
    h.setJournal([...journal(2, 1, startedAt - 60_000), ...journal(2, 3, startedAt + 1_000)], {
      startedAt
    });
    await h.forwarder.forward('error_occurred');
    expect(h.sent[0]!.records.map(record => record.seq)).toEqual([3, 4]);
    expect(cursor(h.storage)).toEqual({ instanceId: RESTARTED, seq: 4 });
  });

  it('stops when the agent answers as a different instance than the context', async () => {
    const h = harness();
    h.setJournal(journal(2), { instanceId: RESTARTED });
    await h.forwarder.forward('error_occurred');
    expect(h.sent).toHaveLength(0);
    expect(cursor(h.storage)).toBeNull();
  });

  it('reads pages of 200 and at most five pages per run', async () => {
    const h = harness();
    h.setJournal(journal(JOURNAL_PAGE_SIZE * 6 + 10));
    await h.forwarder.forward('error_occurred');
    expect(h.fetchPage).toHaveBeenCalledTimes(5);
    expect(h.fetchPage.mock.calls.every(call => call[1] === JOURNAL_PAGE_SIZE)).toBe(true);
    expect(h.fetches).toEqual([0, 200, 400, 600, 800]);
    expect(h.sent.map(input => input.records.length)).toEqual([200, 200, 200, 200, 200]);
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 1_000 });
  });

  it('stops after a short page', async () => {
    const h = harness();
    h.setJournal(journal(JOURNAL_PAGE_SIZE + 5));
    await h.forwarder.forward('error_occurred');
    expect(h.fetches).toEqual([0, 200]);
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 205 });
  });

  it('treats an agent without a journal as nothing to forward', async () => {
    const h = harness();
    h.fetchPage.mockResolvedValueOnce({ instanceId: INSTANCE });
    await h.forwarder.forward('error_occurred');
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([
    ['analytics is disabled', (h: Harness) => h, { analyticsOn: false }],
    [
      'no user is signed in',
      (h: Harness) => {
        h.context.enabled = false;
        return h;
      },
      {}
    ],
    [
      'the agent instance is unknown',
      (h: Harness) => {
        h.context.instanceId = null;
        return h;
      },
      {}
    ],
    [
      'the agent instance is not a uuid',
      (h: Harness) => {
        h.context.instanceId = 'not-a-uuid';
        return h;
      },
      {}
    ]
  ])('does nothing when %s', async (_label, prepare, options) => {
    const h = prepare(harness(options));
    h.setJournal(journal(3));
    await h.forwarder.forward('error_occurred');
    expect(h.fetchPage).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
    expect(h.storage.getItem(JOURNAL_CURSOR_KEY)).toBeNull();
  });

  it('filters records the server would refuse before sending them', async () => {
    const h = harness();
    const base = { at: T0 - 1_000, category: 'spawn', code: 'exit_nonzero' };
    h.setJournal([
      { ...base, seq: 1, props: { duration: 'under_10s', exitCode: 1, killed: false } },
      { ...base, seq: 2, props: { where: 'Users/me/video.mp4' } },
      { ...base, seq: 3, props: { where: 'C:\\video' } },
      { ...base, seq: 4, props: { owner: 'me@example.test' } },
      { ...base, seq: 5, props: { auth: 'Bearer abc' } },
      { ...base, seq: 6, props: { secret: 'myToken' } },
      { ...base, seq: 7, props: { site: 'a://b' } },
      { ...base, seq: 8, category: 'filesystem' as never },
      { ...base, seq: 9, code: 'Not-A-Code' },
      { ...base, seq: 10, at: T0 + 2 * 86_400_000 },
      { ...base, seq: 11, props: { long: 'x'.repeat(65) } },
      {
        ...base,
        seq: 12,
        props: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))
      },
      { ...base, seq: 13 }
    ] as DiagnosticRecord[]);
    await h.forwarder.forward('error_occurred');
    expect(h.sent[0]!.records.map(record => record.seq)).toEqual([1, 13]);
    const wire = JSON.stringify(h.sent[0]!.records);
    for (const forbidden of ['Users', '\\\\', '@', 'Bearer', 'Token', '://']) {
      expect(wire).not.toContain(forbidden);
    }
    // Refused records still move the cursor: they would be refused forever.
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 13 });
  });

  it('sends only the fields the server reads', async () => {
    const h = harness();
    h.setJournal([
      {
        seq: 1,
        at: T0 - 1_000,
        category: 'boot',
        code: 'started',
        extra: 'Users/me'
      } as unknown as DiagnosticRecord
    ]);
    await h.forwarder.forward('error_occurred');
    expect(h.sent[0]!.records).toEqual([
      { seq: 1, at: T0 - 1_000, category: 'boot', code: 'started' }
    ]);
  });

  it('isForwardableRecord rejects non-objects and bad seq', () => {
    expect(isForwardableRecord(null)).toBe(false);
    expect(isForwardableRecord('x')).toBe(false);
    expect(isForwardableRecord({ seq: 0, at: T0, category: 'boot', code: 'started' }, T0)).toBe(
      false
    );
    expect(isForwardableRecord({ seq: 1.5, at: T0, category: 'boot', code: 'started' }, T0)).toBe(
      false
    );
    expect(isForwardableRecord({ seq: 1, at: T0, category: 'boot', code: 'started' }, T0)).toBe(
      true
    );
  });

  it('ignores a corrupt stored cursor', async () => {
    const h = harness();
    h.storage.setItem(JOURNAL_CURSOR_KEY, '{not json');
    h.setJournal(journal(1));
    await h.forwarder.forward('error_occurred');
    expect(h.fetches[0]).toBe(0);
    expect(cursor(h.storage)).toEqual({ instanceId: INSTANCE, seq: 1 });
  });
});

describe('service.ts hook', () => {
  it('forwards on the trigger events after queueing them, and on tab hide', async () => {
    const forward = vi.spyOn(journalForwarder, 'forward').mockResolvedValue(undefined);
    try {
      const service = new ProductAnalytics(async () => false, new MemoryStorage());
      service.setUser('33000000-0000-4000-8000-000000000001');
      service.track('error_occurred', { error_stage: 'unknown', error_code: 'unknown' } as never);
      service.track('tool_ready', {
        tool_identifier: 'compressor',
        outcome: 'failure',
        duration_ms: 10
      });
      service.track('tool_ready', {
        tool_identifier: 'compressor',
        outcome: 'success',
        duration_ms: 10
      });
      service.track('link_check_completed', { outcome: 'success' } as never);
      service.track('link_check_completed', { outcome: 'failure' } as never);
      service.track('link_recovered', {} as never);
      expect(forward.mock.calls.map(call => call[0])).toEqual([
        'error_occurred',
        'tool_ready',
        'link_check_completed',
        'link_recovered'
      ]);

      forward.mockClear();
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(forward).toHaveBeenCalledWith('visibility_hidden');
    } finally {
      forward.mockRestore();
    }
  });

  it('gives the forwarder the signed-in user, installation and agent instance', () => {
    expect(analytics.journalContext().enabled).toBe(false);
    analytics.setAgentContext({
      version: null,
      buildId: null,
      channel: null,
      apiVersion: null,
      toolContracts: {},
      instanceId: INSTANCE
    });
    analytics.setUser('33000000-0000-4000-8000-000000000001');
    const context = analytics.journalContext();
    expect(context).toMatchObject({ enabled: true, instanceId: INSTANCE });
    expect(context.installationId).toMatch(/^[0-9a-f-]{36}$/);
    analytics.setUser(null);
  });
});
