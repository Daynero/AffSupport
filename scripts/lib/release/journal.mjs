import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');

export async function createJournal(directory, runId) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const journalPath = path.join(directory, 'journal.ndjson');
  // Deliberately not `snapshot.json`: that file belongs to the run store, which
  // writes the run object itself and is what the CLI and cleanup read. The
  // journal's own checkpoint pairs a state with the sequence number it was
  // valid at, and writing both shapes to one path made each overwrite the
  // other with something the reader could not interpret.
  const snapshotPath = path.join(directory, 'journal-state.json');
  let sequence = 0;
  let previousDigest = '0'.repeat(64);
  try {
    const events = await readJournal(journalPath, runId);
    const last = events.at(-1);
    if (last) ({ sequence, digest: previousDigest } = last);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return {
    journalPath,
    snapshotPath,
    async append(type, payload, timestamp = new Date().toISOString()) {
      const event = { schemaVersion: 1, runId, sequence: sequence + 1, previousDigest, type, payload, timestamp };
      event.digest = digest(JSON.stringify(event));
      const file = await open(journalPath, 'a', 0o600);
      try { await file.write(`${JSON.stringify(event)}\n`); await file.sync(); } finally { await file.close(); }
      sequence = event.sequence;
      previousDigest = event.digest;
      return event;
    },
    async snapshot(state) {
      const temporary = `${snapshotPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sequence, state }), { mode: 0o600 });
      await rename(temporary, snapshotPath);
      await chmod(snapshotPath, 0o600);
    }
  };
}

export async function readJournal(journalPath, expectedRunId) {
  const raw = await readFile(journalPath, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let previousDigest = '0'.repeat(64);
  return lines.map((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(index === lines.length - 1 ? 'JOURNAL_TORN_TAIL' : 'JOURNAL_CORRUPT'); }
    const actual = event.digest;
    const canonical = { ...event }; delete canonical.digest;
    if (event.schemaVersion !== 1 || event.runId !== expectedRunId || event.sequence !== index + 1 || event.previousDigest !== previousDigest || actual !== digest(JSON.stringify(canonical))) throw new Error('JOURNAL_CORRUPT');
    previousDigest = actual;
    return event;
  });
}

/** Replays valid events; a torn final write is quarantined, never silently trusted. */
export async function recoverJournal(journalPath, runId) {
  try {
    return { events: await readJournal(journalPath, runId), quarantined: null };
  } catch (error) {
    // A run that has not written yet has nothing to recover. This is the only
    // absence that is benign: interior damage and a torn tail are both handled
    // below, and neither is reachable from a file that does not exist.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { events: [], quarantined: null };
    if (!(error instanceof Error) || error.message !== 'JOURNAL_TORN_TAIL') throw error;
    const quarantined = `${journalPath}.torn-${Date.now()}`;
    await rename(journalPath, quarantined);
    const raw = await readFile(quarantined, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    lines.pop();
    await writeFile(journalPath, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    return { events: await readJournal(journalPath, runId), quarantined };
  }
}
