import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
import { createAgentInstance } from '../apps/agent/src/server/instance';
import { removeTemporaryDirectory } from './support/temp-dir';
import { startMinimalAgent } from './support/minimal-agent';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = undefined;
});

it('serves original boot metadata only on explicit history opt-in, protecting older web clients', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-boot-journal-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  const oldBoot = createAgentInstance();
  const boot = createAgentInstance();
  const old = new DiagnosticsLog({ file, instanceId: oldBoot.instanceId });
  old.record('shutdown', 'requested');
  await old.close();
  const current = new DiagnosticsLog({ file, instanceId: boot.instanceId });
  await current.load();
  current.record('boot', 'started');
  current.record('auth', 'handshake');
  const agent = await startMinimalAgent({ diagnostics: current, instanceId: boot.instanceId });
  try {
    const read = (query: string) =>
      agent.app.inject({
        method: 'GET',
        url: `/api/diagnostics${query}`,
        headers: { 'x-session-token': agent.token }
      });
    const legacy = (await read('')).json();
    expect(legacy.log.map((record: { seq: number }) => record.seq)).toEqual([1, 2]);
    expect(legacy.journalProvenance).toBeUndefined();
    const history = (await read('?journal=bound-v1')).json();
    expect(history.journalProvenance).toBe('bound-v1');
    expect(
      history.log.map((record: { agentInstanceId: string }) => record.agentInstanceId)
    ).toEqual([oldBoot.instanceId, boot.instanceId, boot.instanceId]);
    expect(history.log.map((record: { seq: number }) => record.seq)).toEqual([1, 2, 3]);
    const next = (await read('?since=1&limit=1')).json();
    expect(next.log.map((record: { seq: number }) => record.seq)).toEqual([2]);
    expect(next.nextSeq).toBe(2);
    const empty = (await read('?since=2')).json();
    expect(empty.log).toEqual([]);
    expect(empty.nextSeq).toBe(2);
    expect((await read('?journal=unsupported')).statusCode).toBe(400);
  } finally {
    await agent.stop();
    await current.close();
  }
});

it('retains the producing boot and restarts its wire sequence while the file cursor continues', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-boot-journal-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  const firstBoot = createAgentInstance();
  const secondBoot = createAgentInstance();
  const first = new DiagnosticsLog({ file, instanceId: firstBoot.instanceId });
  first.record('boot', 'started');
  first.record('shutdown', 'requested');
  await first.close();
  const second = new DiagnosticsLog({ file, instanceId: secondBoot.instanceId });
  await second.load();
  second.record('boot', 'started');
  expect(second.since(0, 200, true).map(record => record.seq)).toEqual([1]);
  await second.close();
  const third = new DiagnosticsLog({ file, instanceId: createAgentInstance().instanceId });
  await third.load();
  expect(
    third
      .since(0)
      .map(({ seq, agentInstanceId, instanceSeq }) => ({ seq, agentInstanceId, instanceSeq }))
  ).toEqual([
    { seq: 1, agentInstanceId: firstBoot.instanceId, instanceSeq: 1 },
    { seq: 2, agentInstanceId: firstBoot.instanceId, instanceSeq: 2 },
    { seq: 3, agentInstanceId: secondBoot.instanceId, instanceSeq: 1 }
  ]);
  expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3);
  await third.close();
});

it('never backfills a legacy record with the observing boot identity', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-boot-journal-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  await writeFile(
    file,
    JSON.stringify({ seq: 1, at: 1, category: 'boot', code: 'started' }) + '\n'
  );
  const boot = createAgentInstance();
  const log = new DiagnosticsLog({ file, instanceId: boot.instanceId });
  await log.load();
  log.record('boot', 'started');
  expect(log.since(0)[0]).not.toHaveProperty('agentInstanceId');
  expect(log.since(1)[0]).toMatchObject({
    seq: 2,
    agentInstanceId: boot.instanceId,
    instanceSeq: 1
  });
  await log.close();
});

it('rejects malformed persisted provenance instead of forwarding it as an observing boot', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-boot-journal-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  const boot = createAgentInstance();
  const base = { seq: 1, at: 1, category: 'boot', code: 'started' };
  await writeFile(
    file,
    [
      { ...base, agentInstanceId: '/private/path', instanceSeq: 1 },
      { ...base, seq: 2, agentInstanceId: boot.instanceId },
      { ...base, seq: 3, agentInstanceId: boot.instanceId, instanceSeq: -1 },
      { ...base, seq: 4, agentInstanceId: boot.instanceId, instanceSeq: 2 }
    ]
      .map(record => JSON.stringify(record))
      .join('\n') + '\n'
  );
  const log = new DiagnosticsLog({ file, instanceId: boot.instanceId });
  await log.load();
  log.record('boot', 'started');
  expect(log.since(0).map(record => [record.seq, record.instanceSeq])).toEqual([
    [4, 2],
    [5, 3]
  ]);
  await log.close();
});

it('preserves original provenance across bounded file rotation and another boot', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-boot-journal-'));
  const file = path.join(directory, 'diagnostics.jsonl');
  const firstBoot = createAgentInstance();
  const secondBoot = createAgentInstance();
  const first = new DiagnosticsLog({ file, instanceId: firstBoot.instanceId, fileMaxBytes: 1 });
  for (let index = 0; index < 3; index += 1) {
    first.record('stream', 'subscribe');
    await first.flush();
  }
  await first.close();
  const second = new DiagnosticsLog({ file, instanceId: secondBoot.instanceId, fileMaxBytes: 1 });
  await second.load();
  expect(
    second.since(0).map(record => [record.seq, record.agentInstanceId, record.instanceSeq])
  ).toEqual([
    [2, firstBoot.instanceId, 2],
    [3, firstBoot.instanceId, 3]
  ]);
  second.record('boot', 'started');
  await second.close();
  const third = new DiagnosticsLog({ file });
  await third.load();
  expect(
    third.since(0).map(record => [record.seq, record.agentInstanceId, record.instanceSeq])
  ).toEqual([
    [3, firstBoot.instanceId, 3],
    [4, secondBoot.instanceId, 1]
  ]);
  await third.close();
});
