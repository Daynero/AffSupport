import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticCategory, DiagnosticRecord } from '@video-compressor/shared';

/**
 * The native pickers spawn osascript / PowerShell, which cannot run here. Everything else in
 * this file wants the real spawn (the spawn seam is exercised with a real child), so the mock
 * forwards to it unless a test installs a fake for the duration of one picker run.
 */
const spawnControl = vi.hoisted(() => ({
  fake: null as null | ((...args: unknown[]) => unknown)
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      spawnControl.fake
        ? spawnControl.fake(...args)
        : (actual.spawn as (...inner: unknown[]) => unknown)(...args)
  };
});

import {
  DIAGNOSTICS_FILE_MAX_BYTES,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_RECORDS,
  DIAGNOSTICS_PAGE_LIMIT,
  DiagnosticsLog,
  countBucket,
  durationBucket,
  isSafeDiagnosticValue,
  setActiveDiagnosticsLog,
  skewBucket
} from '../apps/agent/src/server/diagnostics-log.js';
import { ChannelHub, EventChannel } from '../apps/agent/src/server/sse.js';
import {
  ENTITLEMENT_TOKEN_PREFIX,
  EntitlementGate
} from '../apps/agent/src/entitlement/entitlement.js';
import { spawnManaged } from '../apps/agent/src/power/spawn.js';
import { selectOutputFolder } from '../apps/agent/src/files/picker.js';
import { findDroppedFolder, findDroppedSource } from '../apps/agent/src/files/dropped-source.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { defaultImageEmbeddingSettings } from '../packages/shared/src/types.js';
import { optimalSettings } from './helpers.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { waitFor } from './support/wait.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-diagnostics-'));
});
afterEach(async () => {
  setActiveDiagnosticsLog(null);
  spawnControl.fake = null;
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

const file = () => path.join(directory, 'diagnostics.jsonl');

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readRecords(target: string): Promise<DiagnosticRecord[]> {
  const raw = await readFile(target, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as DiagnosticRecord);
}

describe('the journal in memory', () => {
  it('assigns a monotonic seq and pages oldest first with since/limit', () => {
    const log = new DiagnosticsLog({ now: () => 1_000 });
    for (let index = 0; index < 10; index += 1) log.record('stream', 'subscribe', { n: index });

    const first = log.since(0, 4);
    expect(first.map(record => record.seq)).toEqual([1, 2, 3, 4]);
    expect(first[0]).toEqual({
      seq: 1,
      at: 1_000,
      category: 'stream',
      code: 'subscribe',
      props: { n: 0 }
    });
    const next = log.since(4, 4);
    expect(next.map(record => record.seq)).toEqual([5, 6, 7, 8]);
    expect(log.since(8).map(record => record.seq)).toEqual([9, 10]);
    expect(log.since(10)).toEqual([]);
    expect(log.since(99)).toEqual([]);
    expect(log.latestSeq()).toBe(10);
  });

  it('caps a page at the contract limit however large the request', () => {
    const log = new DiagnosticsLog();
    for (let index = 0; index < DIAGNOSTICS_PAGE_LIMIT + 50; index += 1) {
      log.record('spawn', 'started', { tool: 'x' });
    }
    expect(log.since(0, 10_000)).toHaveLength(DIAGNOSTICS_PAGE_LIMIT);
    expect(log.since(0, 0)).toHaveLength(1);
  });

  it('publishes the contract bounds', () => {
    expect(DIAGNOSTICS_MAX_RECORDS).toBe(2_000);
    expect(DIAGNOSTICS_MAX_BYTES).toBe(1_048_576);
    expect(DIAGNOSTICS_FILE_MAX_BYTES).toBe(1_048_576);
    expect(DIAGNOSTICS_PAGE_LIMIT).toBe(500);
  });

  it('keeps at most 2 000 records, dropping the oldest', () => {
    const log = new DiagnosticsLog();
    for (let index = 0; index < 2_500; index += 1) log.record('power', 'tick');
    expect(log.size()).toBe(2_000);
    expect(log.since(0, 1)[0]?.seq).toBe(501);
    expect(log.latestSeq()).toBe(2_500);
    expect(log.byteSize()).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
  });

  it('keeps at most 1 MiB of records when that bound is reached first', () => {
    // Every record is ~140 bytes with a 64-character enum value; the byte bound is reached
    // long before the record bound at a 4 KiB ceiling, which is what is being exercised.
    const log = new DiagnosticsLog({ maxBytes: 4_096 });
    const value = 'x'.repeat(64);
    for (let index = 0; index < 200; index += 1) log.record('team', 'event', { value });
    expect(log.byteSize()).toBeLessThanOrEqual(4_096);
    expect(log.size()).toBeLessThan(200);
    expect(log.size()).toBeGreaterThan(10);
    expect(log.latestSeq()).toBe(200);
    // The in-memory tally matches what the records actually serialise to.
    const serialized = log
      .since(0, 500)
      .map(record => JSON.stringify(record).length + 1)
      .reduce((sum, length) => sum + length, 0);
    expect(serialized).toBe(log.byteSize());
  });

  it('serves copies, so a caller cannot edit the journal through a page', () => {
    const log = new DiagnosticsLog();
    log.record('boot', 'started', { version: '1' });
    const page = log.since(0);
    (page[0] as DiagnosticRecord).code = 'tampered';
    expect(log.since(0)[0]?.code).toBe('started');
  });
});

describe('the privacy fence', () => {
  const log = () => new DiagnosticsLog();

  it('refuses a category outside the closed set', () => {
    const journal = log();
    expect(journal.record('files' as DiagnosticCategory, 'opened')).toBe(false);
    expect(journal.rejectedCount()).toBe(1);
    expect(journal.size()).toBe(0);
  });

  it.each(['Bad', '1x', 'a', 'has-dash', 'has space', `${'a'.repeat(65)}`, ''])(
    'refuses the code %j',
    code => {
      const journal = log();
      expect(journal.record('boot', code)).toBe(false);
      expect(journal.rejectedCount()).toBe(1);
    }
  );

  it.each([
    ['a path', '/Users/ada/Movies/clip.mp4'],
    ['a Windows path', 'C:\\Users\\Ada\\clip.mp4'],
    ['a URL', 'https://example.com/pair'],
    ['a scheme without a path', 'file://'],
    ['the word token', 'session token'],
    ['the word Token in any case', 'xTOKENx'],
    ['a bearer credential', 'Bearer abc'],
    ['prose longer than 64 characters', 'a'.repeat(65)],
    ['an empty string', '']
  ])('refuses a string value that is %s', (_label, value) => {
    expect(isSafeDiagnosticValue(value)).toBe(false);
    const journal = log();
    expect(journal.record('auth', 'handshake', { origin: value })).toBe(false);
    expect(journal.rejectedCount()).toBe(1);
    expect(journal.size()).toBe(0);
  });

  it('refuses a non-finite number, a nested object, an array and a bad key', () => {
    const journal = log();
    expect(journal.record('spawn', 'exited', { duration: Number.NaN })).toBe(false);
    expect(journal.record('spawn', 'exited', { duration: Infinity })).toBe(false);
    expect(journal.record('spawn', 'exited', { nested: { a: 1 } as unknown as number })).toBe(
      false
    );
    expect(journal.record('spawn', 'exited', { list: [1] as unknown as number })).toBe(false);
    expect(journal.record('spawn', 'exited', { 'bad key': 1 })).toBe(false);
    expect(journal.record('spawn', 'exited', { '/path': 1 })).toBe(false);
    expect(journal.rejectedCount()).toBe(6);
    expect(journal.size()).toBe(0);
  });

  it('refuses more than sixteen properties on one record', () => {
    const journal = log();
    const props: Record<string, number> = {};
    for (let index = 0; index < 17; index += 1) props[`p${index}`] = index;
    expect(journal.record('team', 'event', props)).toBe(false);
    expect(journal.rejectedCount()).toBe(1);
  });

  it('keeps a record whose values are all from a vocabulary', () => {
    const journal = log();
    expect(
      journal.record('spawn', 'exited', {
        tool: 'compressor',
        outcome: 'ok',
        duration: 'under_10s',
        count: 3,
        ok: true
      })
    ).toBe(true);
    expect(journal.rejectedCount()).toBe(0);
    expect(journal.since(0)[0]?.props).toEqual({
      tool: 'compressor',
      outcome: 'ok',
      duration: 'under_10s',
      count: 3,
      ok: true
    });
  });

  it('drops an undefined property rather than the record, and omits empty props', () => {
    const journal = log();
    expect(journal.record('team', 'event', { a: 1, b: undefined as unknown as number })).toBe(true);
    expect(journal.since(0)[0]?.props).toEqual({ a: 1 });
    expect(journal.record('team', 'event', {})).toBe(true);
    expect('props' in (journal.since(1)[0] as DiagnosticRecord)).toBe(false);
  });

  it('buckets durations, counts and clock skew into closed vocabularies', () => {
    expect(durationBucket(10)).toBe('under_1s');
    expect(durationBucket(5_000)).toBe('under_10s');
    expect(durationBucket(30_000)).toBe('under_1m');
    expect(durationBucket(300_000)).toBe('under_10m');
    expect(durationBucket(1_800_000)).toBe('under_1h');
    expect(durationBucket(7_200_000)).toBe('over_1h');
    expect(durationBucket(-1)).toBe('unknown');
    expect(countBucket(0)).toBe('none');
    expect(countBucket(1)).toBe('one');
    expect(countBucket(5)).toBe('under_5');
    expect(countBucket(20)).toBe('under_20');
    expect(countBucket(100)).toBe('under_100');
    expect(countBucket(101)).toBe('over_100');
    expect(skewBucket(1_000)).toBe('under_1m');
    expect(skewBucket(120_000)).toBe('ahead_under_5m');
    expect(skewBucket(-120_000)).toBe('behind_under_5m');
    expect(skewBucket(600_000)).toBe('ahead_over_5m');
    expect(skewBucket(Number.NaN)).toBe('unknown');
    for (const value of [durationBucket(1), countBucket(1), skewBucket(1), skewBucket(-600_000)]) {
      expect(isSafeDiagnosticValue(value)).toBe(true);
    }
  });
});

describe('the journal on disk', () => {
  it('writes atomically on the timer and leaves no temp file behind', async () => {
    const log = new DiagnosticsLog({ file: file(), flushIntervalMs: 20 });
    log.record('boot', 'started', { version: '1.0.0' });
    await waitFor(() => exists(file()), { describe: 'the journal file to appear' });
    await log.close();
    expect(await exists(`${file()}.tmp`)).toBe(false);
    const stored = await readRecords(file());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ seq: 1, category: 'boot', code: 'started' });
  });

  it('continues the sequence across a reload and serves the previous boot', async () => {
    const first = new DiagnosticsLog({ file: file() });
    first.record('boot', 'started');
    first.record('shutdown', 'requested', { reason: 'update', code: 76 });
    await first.close();

    const second = new DiagnosticsLog({ file: file() });
    await second.load();
    expect(second.latestSeq()).toBe(2);
    expect(second.since(0).map(record => record.code)).toEqual(['started', 'requested']);
    expect(second.record('boot', 'started')).toBe(true);
    expect(second.latestSeq()).toBe(3);
    await second.flush();

    // The file carries all three, in order, exactly once.
    const stored = await readRecords(file());
    expect(stored.map(record => record.seq)).toEqual([1, 2, 3]);

    const third = new DiagnosticsLog({ file: file() });
    await third.load();
    expect(third.since(2).map(record => record.seq)).toEqual([3]);
    expect(third.latestSeq()).toBe(3);
  });

  it('ignores corrupt lines and lines the fence would now refuse', async () => {
    await writeFile(
      file(),
      [
        'not json',
        JSON.stringify({ seq: 1, at: 1, category: 'boot', code: 'started' }),
        JSON.stringify({ seq: 2, at: 1, category: 'files', code: 'opened' }),
        JSON.stringify({ seq: 3, at: 1, category: 'auth', code: 'handshake', props: { o: '/x' } }),
        JSON.stringify({ seq: 'four', at: 1, category: 'auth', code: 'handshake' }),
        JSON.stringify({ seq: 5, at: 1, category: 'auth', code: 'handshake' })
      ].join('\n') + '\n'
    );
    const log = new DiagnosticsLog({ file: file() });
    await log.load();
    expect(log.since(0).map(record => record.seq)).toEqual([1, 5]);
    expect(log.latestSeq()).toBe(5);
  });

  it('starts empty when the file is missing or unreadable', async () => {
    const log = new DiagnosticsLog({ file: path.join(directory, 'nested', 'missing.jsonl') });
    await expect(log.load()).resolves.toBeUndefined();
    expect(log.latestSeq()).toBe(0);
    expect(log.record('boot', 'started')).toBe(true);
    await log.flush();
    expect(await exists(path.join(directory, 'nested', 'missing.jsonl'))).toBe(true);
  });

  it('rotates at the byte ceiling and keeps exactly one previous file', async () => {
    const log = new DiagnosticsLog({ file: file(), fileMaxBytes: 600 });
    const batch = async (label: string) => {
      for (let index = 0; index < 4; index += 1) log.record('stream', 'subscribe', { label });
      await log.flush();
    };
    await batch('first');
    expect(await exists(`${file()}.1`)).toBe(false);
    await batch('second');
    expect(await exists(`${file()}.1`)).toBe(true);
    const previous = await readRecords(`${file()}.1`);
    const current = await readRecords(file());
    expect(previous.map(record => record.seq)).toEqual([1, 2, 3, 4]);
    expect(current.map(record => record.seq)).toEqual([5, 6, 7, 8]);
    expect((await stat(file())).size).toBeLessThanOrEqual(600);

    await batch('third');
    // The second batch took the place of the first; there is never a `.2`.
    expect((await readRecords(`${file()}.1`)).map(record => record.seq)).toEqual([5, 6, 7, 8]);
    expect((await readRecords(file())).map(record => record.seq)).toEqual([9, 10, 11, 12]);
    expect(await exists(`${file()}.2`)).toBe(false);

    // A reload reads both files, so the sequence continues past everything rotated out.
    const reloaded = new DiagnosticsLog({ file: file(), fileMaxBytes: 600 });
    await reloaded.load();
    expect(reloaded.since(0).map(record => record.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(reloaded.latestSeq()).toBe(12);
  });

  it('accepts nothing after close', async () => {
    const log = new DiagnosticsLog({ file: file() });
    log.record('boot', 'started');
    await log.close();
    expect(log.record('boot', 'listening')).toBe(false);
    expect((await readRecords(file())).map(record => record.code)).toEqual(['started']);
  });
});

/**
 * One assertion per writer category with a unit seam: the triggering action leaves a record,
 * and the record carries categories only. Boot and shutdown live in the entrypoint, which
 * has no seam short of launching the process; they are exercised by the real-agent harness.
 */
describe('writers', () => {
  let journal: DiagnosticsLog;
  beforeEach(() => {
    journal = new DiagnosticsLog();
    setActiveDiagnosticsLog(journal);
  });

  const records = (category: DiagnosticCategory) =>
    journal.since(0, 500).filter(record => record.category === category);

  it('stream: subscribe, evict for capacity and stall, close_all', () => {
    const hub = new ChannelHub();
    const channel = new EventChannel<{ type: string }>(new Set(), () => ({ type: 'state' }));
    channel.publishOn(hub, 'compressor');

    const sockets = Array.from({ length: 9 }, () => ({
      write: vi.fn(),
      destroy: vi.fn(),
      writableLength: 0
    }));
    for (const socket of sockets) hub.subscribe(socket, ['compressor', 'missing']);
    // Nine subscribers on a channel of eight: the oldest was evicted.
    expect(records('stream').filter(record => record.code === 'subscribe')).toHaveLength(9);
    expect(records('stream')[0]?.props).toEqual({ channels: 1 });
    expect(records('stream').filter(record => record.code === 'evict')).toEqual([
      expect.objectContaining({ props: { reason: 'capacity' } })
    ]);

    (sockets[8] as { writableLength: number }).writableLength = 2_000_000;
    channel.broadcast({ type: 'state' });
    expect(
      records('stream')
        .filter(record => record.code === 'evict')
        .map(r => r.props)
    ).toEqual([{ reason: 'capacity' }, { reason: 'stalled' }]);

    hub.closeAll('update');
    EventChannel.closeAll('update');
    const closes = records('stream').filter(record => record.code === 'close_all');
    expect(closes.map(record => record.props)).toEqual([
      { transport: 'stream', reason: 'update', subscribers: 7 },
      { transport: 'legacy', reason: 'update' }
    ]);
  });

  it('entitlement: a decision per transition, with the skew bucket on an accepted token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const issue = (payload: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const signed = `${ENTITLEMENT_TOKEN_PREFIX}.${encoded}`;
      const signature = signBytes('sha256', Buffer.from(signed, 'utf8'), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363'
      });
      return `${signed}.${signature.toString('base64url')}`;
    };
    let now = 1_700_000_000_000;
    const gate = new EntitlementGate({
      publicKeyBase64,
      stateFile: path.join(directory, 'entitlement.json'),
      now: () => now
    });

    gate.status();
    gate.status();
    expect(records('entitlement').map(record => record.props)).toEqual([
      { decision: 'missing', skew: 'unknown' }
    ]);

    await expect(gate.acceptToken('wat1.garbage.garbage')).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );
    const iat = Math.floor(now / 1000) + 120;
    await gate.acceptToken(issue({ v: 1, sub: 'user-1', plan: 'free', iat, exp: iat + 3600 }));
    now += 3600 * 1000 + 130_000;
    gate.status();
    expect(records('entitlement').map(record => record.props)).toEqual([
      { decision: 'missing', skew: 'unknown' },
      { decision: 'invalid', skew: 'unknown' },
      { decision: 'active', skew: 'ahead_under_5m' },
      { decision: 'grace', skew: 'unknown' }
    ]);
    // Nothing of the token reached the journal.
    expect(JSON.stringify(journal.since(0))).not.toContain('wat1');

    const unenforced = new EntitlementGate({ stateFile: path.join(directory, 'none.json') });
    unenforced.status();
    expect(records('entitlement').at(-1)?.props).toEqual({
      decision: 'not_enforced',
      skew: 'unknown'
    });
  });

  it('spawn: started and exited with the tool id, outcome and duration bucket only', async () => {
    const child = spawnManaged(null, process.execPath, ['-e', 'process.exit(3)'], {
      toolId: 'diag_probe'
    });
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    await waitFor(() => records('spawn').length === 2, { describe: 'the exit record' });
    expect(records('spawn').map(record => record.code)).toEqual(['started', 'exited']);
    expect(records('spawn')[1]?.props).toEqual({
      tool: 'diag_probe',
      outcome: 'nonzero',
      duration: expect.stringMatching(/^under_/u)
    });
    expect(JSON.stringify(journal.since(0))).not.toContain(process.execPath);

    const missing = spawnManaged(null, path.join(directory, 'no-such-binary'), [], {
      toolId: 'diag_probe'
    });
    missing.once('error', () => undefined);
    await waitFor(() => records('spawn').length === 4, { describe: 'the spawn_error record' });
    expect(records('spawn')[3]?.props).toMatchObject({ outcome: 'spawn_error' });
    expect(JSON.stringify(journal.since(0))).not.toContain(directory);
  });

  it('picker: launch and a categorical exit, never the chosen path', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnControl.fake = () => {
      queueMicrotask(() => {
        child.stdout.emit('data', '/Users/ada/Movies/\n');
        child.emit('close', 0);
      });
      return child;
    };
    // The picker's own platform branch is the one exception to the platform rule; this
    // machine is not Windows, so the osascript runner is what runs.
    const chosen = await selectOutputFolder();
    expect(chosen).toBe('/Users/ada/Movies');
    expect(records('picker').map(record => [record.code, record.props])).toEqual([
      ['launch', { kind: 'output_folder', platform: 'macos' }],
      ['exit', { kind: 'output_folder', outcome: 'chosen', chosen: 1 }]
    ]);
    expect(JSON.stringify(journal.since(0))).not.toContain('Movies');

    spawnControl.fake = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', 'execution error: User canceled. (-128)');
        child.emit('close', 1);
      });
      return child;
    };
    await expect(selectOutputFolder()).resolves.toBeNull();
    expect(records('picker').at(-1)?.props).toEqual({
      kind: 'output_folder',
      outcome: 'cancelled',
      chosen: 0
    });
  });

  it('drop: a location class and an outcome, never the file name', async () => {
    await expect(findDroppedSource('secret-campaign.mp4', Number.NaN, 0)).resolves.toBeNull();
    await expect(
      findDroppedFolder({
        folderName: '../escape',
        relPath: 'a/b.mp4',
        fileName: 'b.mp4',
        size: 1,
        lastModified: 0
      })
    ).resolves.toBeNull();
    expect(records('drop').map(record => [record.code, record.props])).toEqual([
      ['resolve_file', { location: 'none', outcome: 'invalid' }],
      ['resolve_folder', { location: 'none', outcome: 'invalid' }]
    ]);
    expect(JSON.stringify(journal.since(0))).not.toContain('secret-campaign');
  });

  it('update: the drain state when a handoff is requested', () => {
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => undefined,
      [],
      { ...optimalSettings, imageEmbedding: defaultImageEmbeddingSettings() },
      null,
      new ImageAssetStore(path.join(directory, 'images'))
    );
    queue.requestUpdateDrain('9.9.9+999');
    expect(records('update')).toEqual([
      expect.objectContaining({ code: 'drain_requested', props: { state: 'pending' } })
    ]);
    expect(JSON.stringify(journal.since(0))).not.toContain('9.9.9');
  });
});
