import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The bridge's own durable record, and the state machine over it.
 *
 * The runner has an outbox; this is the other side of the wire. Keeping them
 * separate is the point: the runner's record says "I asked", this one says "I
 * was asked", and a release that cannot tell those apart is a release that asks
 * twice for a failure somebody is already fixing.
 *
 * Everything here is a pure function of a directory, so the transport can be
 * tested without spawning anything and the executable stays a thin shell around
 * it.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** What the runner is allowed to see. `unknown` is a real answer, not an error. */
export const BRIDGE_STATES = Object.freeze(['unknown', 'acknowledged', 'completed']);

function recordPath(directory, jobId) {
  // A job id reaches this from another process, so it names a file only after
  // it has been proven to be one path segment and nothing else.
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(jobId ?? '')) throw new Error('BRIDGE_JOB_ID_INVALID');
  return path.join(directory, `${jobId}.json`);
}

async function replaceRecord(file, record) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  await rename(temporary, file);
  return record;
}

export async function readJob(directory, jobId) {
  try {
    return JSON.parse(await readFile(recordPath(directory, jobId), 'utf8'));
  } catch {
    return null;
  }
}

export async function listJobs(directory) {
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

/**
 * Accepting a job, at most once.
 *
 * Delivery is at-least-once by design — the runner writes "submitted" before it
 * sends, so a reply lost in transit is resent. Answering an existing job with
 * its current state rather than creating a second one is what makes that safe,
 * and it is the whole reason this side keeps a record at all.
 */
/**
 * @param {string} directory
 * @param {{jobId?: string, fingerprint?: string, runId?: string, payload?: unknown}} request
 * @param {number} [now]
 */
export async function submitJob(directory, { jobId, fingerprint, runId, payload }, now = Date.now()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readJob(directory, jobId);
  if (existing) return existing;
  return replaceRecord(recordPath(directory, jobId), {
    schemaVersion: 1,
    jobId,
    fingerprint,
    runId: runId ?? null,
    payload: payload ?? null,
    state: 'acknowledged',
    receivedAt: new Date(now).toISOString(),
    result: null,
    resultTakenAt: null
  });
}

/**
 * Recording the repair somebody actually made.
 *
 * `status` is the human's verdict, and `revalidationRequired` is deliberately
 * not ours to set: the runner treats a bridge saying "repaired" as a claim
 * about source and re-runs its own gates regardless. This records an answer; it
 * never grants one.
 */
export async function completeJob(directory, jobId, result, now = Date.now()) {
  const existing = await readJob(directory, jobId);
  if (!existing) return null;
  if (!['repaired', 'refused', 'needs_owner'].includes(result?.status ?? ''))
    throw new Error('BRIDGE_RESULT_STATUS_INVALID');
  return replaceRecord(recordPath(directory, jobId), {
    ...existing,
    state: 'completed',
    result: {
      status: result.status,
      notes: typeof result.notes === 'string' ? result.notes.slice(0, 4000) : null,
      completedAt: new Date(now).toISOString()
    }
  });
}

/** The runner has taken delivery of a result; the record keeps when. */
export async function takeResult(directory, jobId, now = Date.now()) {
  const existing = await readJob(directory, jobId);
  if (!existing) return null;
  return replaceRecord(recordPath(directory, jobId), {
    ...existing,
    resultTakenAt: new Date(now).toISOString()
  });
}

/**
 * One request in, one reply out.
 *
 * A reply always carries the job id and fingerprint it was asked about, because
 * the runner discards anything that does not — which is how a reply about the
 * wrong job cannot be mistaken for an answer.
 *
 * @param {string} directory
 * @param {{version?: number, operation?: string, jobId?: string, fingerprint?: string, runId?: string, payload?: unknown}} request
 * @param {number} [now]
 * @returns {Promise<{version: number, jobId: string|null, fingerprint: string|null, state: string, result?: {status: string, notes: string|null, completedAt: string}, error?: string}>}
 */
export async function handleRequest(directory, request, now = Date.now()) {
  const base = {
    version: BRIDGE_PROTOCOL_VERSION,
    jobId: request?.jobId ?? null,
    fingerprint: request?.fingerprint ?? null
  };
  if (request?.version !== BRIDGE_PROTOCOL_VERSION)
    return { ...base, state: 'unknown', error: 'PROTOCOL_VERSION_MISMATCH' };

  try {
    if (request.operation === 'submit') {
      const job = await submitJob(directory, request ?? {}, now);
      return { ...base, state: job.state, ...(job.result ? { result: job.result } : {}) };
    }
    if (request.operation === 'query') {
      const job = await readJob(directory, request.jobId);
      // A job this side has never seen is `unknown`, which is the answer that
      // tells the runner it is safe to submit again.
      if (!job) return { ...base, state: 'unknown' };
      return { ...base, state: job.state, ...(job.result ? { result: job.result } : {}) };
    }
    if (request.operation === 'acknowledge') {
      const job = await takeResult(directory, request.jobId, now);
      return { ...base, state: job?.state ?? 'unknown' };
    }
  } catch (error) {
    return {
      ...base,
      state: 'unknown',
      error: error instanceof Error ? error.message : 'BRIDGE_ERROR'
    };
  }
  return { ...base, state: 'unknown', error: 'OPERATION_UNSUPPORTED' };
}
