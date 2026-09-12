import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The durable outbox for unattended repair requests.
 *
 * A release that fails at 3am must be able to ask for help without a model
 * running, without a chat window open, and without ever asking twice for the
 * same failure. That is what this file is: one small JSON record per failure
 * fingerprint, written before anything is sent, updated in place afterwards.
 *
 * The identity is the fingerprint, not the attempt. Re-enqueueing the same
 * failure returns the record that already exists — which is what makes delivery
 * safely at-least-once: the bridge may receive a submission twice, but there is
 * only ever one job for it to start.
 */

/** First retry after 30 s, doubling to a 5 min ceiling. */
const BACKOFF_FLOOR_MS = 30_000;
const BACKOFF_CEILING_MS = 5 * 60_000;

export const HANDOFF_STATES = Object.freeze([
  'delivery_pending',
  'acknowledged',
  'completed',
  'needs_external_decision'
]);

export function backoffMs(attempts) {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** (attempts - 1));
}

function recordPath(directory, fingerprint) {
  return path.join(directory, `${fingerprint}.json`);
}

async function replaceRecord(file, record) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, file);
  return record;
}

/**
 * Records a failure as a job to deliver, or returns the job that already
 * describes it. `jobId` is derived from the run and failure fingerprint by the
 * caller, so a restarted worker recreates the same identity rather than a new
 * one.
 */
export async function enqueueHandoff(directory, job, now = Date.now()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = recordPath(directory, job.fingerprint);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return replaceRecord(file, {
    ...job,
    state: 'delivery_pending',
    attempts: 0,
    submitted: false,
    createdAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now).toISOString(),
    result: null,
    // A bridge saying "repaired" is a claim about source, never about gates.
    revalidationRequired: false
  });
}

export async function readHandoff(directory, fingerprint) {
  try {
    return JSON.parse(await readFile(recordPath(directory, fingerprint), 'utf8'));
  } catch {
    return null;
  }
}

export async function listHandoffs(directory) {
  try {
    const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
    const records = await Promise.all(
      names.map(async name => {
        try {
          return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
        } catch {
          return null;
        }
      })
    );
    return records.filter(Boolean);
  } catch {
    return [];
  }
}

/** Jobs that still need delivery and whose backoff has elapsed. */
export async function dueHandoffs(directory, now = Date.now()) {
  return (await listHandoffs(directory)).filter(
    record =>
      record.state === 'delivery_pending' && Date.parse(record.nextAttemptAt ?? 0) <= now
  );
}

/**
 * Persists "this job has been sent" *before* it is sent.
 *
 * The order matters more than it looks. If the flag were written after a
 * successful reply, a reply lost in transit would leave a record saying the job
 * was never submitted — and the next attempt would submit it again, asking for
 * a second repair of a failure somebody is already fixing. Written first, a lost
 * reply merely means the next attempt has to ask what happened.
 */
export async function markSubmitting(directory, record) {
  if (record.submitted) return record;
  return replaceRecord(recordPath(directory, record.fingerprint), { ...record, submitted: true });
}

export async function recordAttempt(directory, record, patch, now = Date.now()) {
  const attempts = record.attempts + 1;
  return replaceRecord(recordPath(directory, record.fingerprint), {
    ...record,
    ...patch,
    attempts,
    nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString()
  });
}

/**
 * Stores a terminal answer from the bridge.
 *
 * `repaired` is the interesting one: it sets `revalidationRequired`, and
 * nothing in this module ever clears it. The worker must rerun the affected
 * gates against the repaired source, because a bridge that could mark its own
 * repair as verified would be a way to publish unverified code.
 */
export async function recordResult(directory, fingerprint, { status, repairReference = null }, now = Date.now()) {
  const record = await readHandoff(directory, fingerprint);
  if (!record) return null;
  const state =
    status === 'needsExternalDecision'
      ? 'needs_external_decision'
      : status === 'repaired' || status === 'cannotRepair'
        ? 'completed'
        : record.state;
  return replaceRecord(recordPath(directory, fingerprint), {
    ...record,
    state,
    result: { status, repairReference, at: new Date(now).toISOString() },
    revalidationRequired: status === 'repaired'
  });
}
