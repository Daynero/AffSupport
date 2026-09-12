import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function betaPackageInput({ runtimePath, outputRoot, published = false }) {
  if (published) return { ok: false, code: 'PUBLISHED_REBUILD_FORBIDDEN' };
  if (!path.isAbsolute(runtimePath) || !path.isAbsolute(outputRoot))
    return { ok: false, code: 'BETA_INPUT_NOT_ABSOLUTE' };
  return { ok: true, runtimePath, outputRoot };
}

export function ownsBetaService({ pid, ownerRunId }, runId) {
  return Number.isInteger(pid) && pid > 0 && ownerRunId === runId;
}

/**
 * What a running beta stack keeps claimed after it has finished starting.
 *
 * The stack is the one heavy thing that stays. Holding the exclusive slot for
 * its whole life would stall every later step, so startup takes the slot and
 * then hands back a *standing reservation*: memory and disk the scheduler
 * subtracts from what it believes is free, without preventing other work. The
 * resident bytes already visible to the probe are removed, because available
 * memory reported by the kernel has them subtracted once already.
 */
export function residentBetaReservation(profile, { residentBytes = 0 } = {}) {
  const stack = profile?.classes?.beta_stack;
  if (!stack) throw new Error('RESOURCE_CLASS_INVALID');
  return Object.freeze({
    ramBytes: Math.max(0, stack.ramBytes - residentBytes),
    diskBytes: stack.diskBytes
  });
}

/**
 * Sums the standing reservations of every beta stack that recorded itself as
 * owned. A record without a reservation is an older or borrowed stack and
 * contributes nothing: this function never invents a claim on the machine.
 */
export async function readResidentReservations(directory) {
  let entries;
  try {
    entries = (await readdir(directory)).filter(name => name.endsWith('beta-service.json'));
  } catch {
    return Object.freeze({ ramBytes: 0, diskBytes: 0 });
  }
  let ramBytes = 0;
  let diskBytes = 0;
  for (const name of entries) {
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (record?.schemaVersion !== 1 || !record.stackStarted) continue;
      ramBytes += Number(record.reservation?.ramBytes) || 0;
      diskBytes += Number(record.reservation?.diskBytes) || 0;
    } catch {
      // An unreadable record is not evidence of a free machine, but it is also
      // not a number to add; the stop path refuses on it separately.
    }
  }
  return Object.freeze({ ramBytes, diskBytes });
}

export function digestOf(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Whether a file the runner wrote may be restored to what it replaced.
 *
 * Only the runner's own untouched content is safe to roll back. If somebody
 * edited the environment file while beta was up, their edit is the newer
 * intent and overwriting it would destroy work that was never ours.
 */
export function restorableEnv({ writtenDigest, currentContent }) {
  if (typeof writtenDigest !== 'string' || !writtenDigest) return { ok: false, code: 'ENV_PROVENANCE_UNKNOWN' };
  if (currentContent === null || currentContent === undefined) return { ok: false, code: 'ENV_MISSING' };
  return digestOf(currentContent) === writtenDigest
    ? { ok: true }
    : { ok: false, code: 'ENV_MODIFIED_EXTERNALLY' };
}
