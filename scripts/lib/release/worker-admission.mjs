import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createProbeSampler, inspectInstalledProbe } from './probes-macos.mjs';
import { createLeaseBook } from './leases.mjs';
import { createResourceAdmission } from './resources.mjs';
import { readResidentReservations } from './adapters/beta.mjs';
import { stepDefinition } from './steps.mjs';

/**
 * The worker's own gate on the machine.
 *
 * The lease server exists for child commands that ask through a socket. This is
 * the other half: the worker itself must not start a heavy step on a machine
 * that cannot afford it, and without this the whole resource apparatus would be
 * a well-tested library nothing ever called.
 *
 * It fails closed. No installed probe means no measurement, and no measurement
 * means no heavy work — a release that guessed the machine was fine is exactly
 * the outcome this feature exists to prevent.
 */

const PROVENANCE = 'ResourceProbe.provenance.json';

/** Where a runner installation keeps the probe it was provisioned with. */
export async function installedProbeFrom(env = process.env, root = process.cwd()) {
  if (env.SOTY_RELEASE_PROBE && env.SOTY_RELEASE_PROBE_DIGEST) {
    return { executable: env.SOTY_RELEASE_PROBE, digest: env.SOTY_RELEASE_PROBE_DIGEST };
  }
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'release/automation/probe', PROVENANCE), 'utf8')
    );
    return { executable: manifest.executable, digest: manifest.digest };
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.());

/**
 * @param {{
 *   runId: string,
 *   profile: object,
 *   probe?: {executable: string, digest: string} | null,
 *   reservationsDirectory?: string,
 *   onWait?: (event: {stepId: string, reason: string, waitedMs: number, nextCheckAt: number}) => void | Promise<void>
 * }} options
 */
export async function createWorkerAdmission({
  runId,
  profile,
  probe,
  reservationsDirectory = 'release/automation',
  onWait = () => {}
}) {
  let report = onWait;
  if (!probe) {
    return {
      setWaitReporter(reporter) {
        report = reporter;
      },
      async withAdmission(stepId) {
        throw new Error(`PROBE_UNAVAILABLE: no installed resource probe, refusing to start ${stepId}`);
      },
      stop() {}
    };
  }
  const inspected = await inspectInstalledProbe(probe);
  if (!inspected.ok) {
    return {
      setWaitReporter(reporter) {
        report = reporter;
      },
      async withAdmission(stepId) {
        throw new Error(`PROBE_UNAVAILABLE: ${inspected.reason} — refusing to start ${stepId}`);
      },
      stop() {}
    };
  }

  const sampler = createProbeSampler({ executable: probe.executable });
  const scheduler = createResourceAdmission(profile, createLeaseBook(), {
    standingReservation: () => standing
  });
  // A resident beta stack's claim is re-read rather than cached: it can start or
  // stop while this release is waiting.
  let standing = { ramBytes: 0, diskBytes: 0 };
  let running = true;

  const pump = (async () => {
    while (running) {
      scheduler.sample(await sampler.sample());
      standing = await readResidentReservations(reservationsDirectory);
      await sleep(profile.sampleIntervalMs);
    }
  })();
  pump.catch(() => {
    // A failed sample is already an unknown sample; the loop stops and
    // admission stays closed, which is the safe direction.
  });

  return {
    /** The worker owns the journal, so it replaces the reporter once it has one. */
    setWaitReporter(reporter) {
      report = reporter;
    },
    async withAdmission(stepId, run) {
      const resourceClass = stepDefinition(stepId).resourceClass;
      const startedWaiting = Date.now();
      let lease = null;
      let announced = '';
      while (!lease) {
        const decision = scheduler.request({ runId, resourceClass });
        if (decision.ok) {
          lease = decision;
          break;
        }
        // The wait itself is normal progress, not a failure; it is reported so
        // status can say what the release is waiting for.
        if (decision.reason !== announced) {
          announced = decision.reason;
          await report({
            stepId,
            reason: decision.reason,
            waitedMs: Date.now() - startedWaiting,
            nextCheckAt: Date.now() + profile.sampleIntervalMs
          });
        }
        await sleep(profile.sampleIntervalMs);
      }
      try {
        return await run();
      } finally {
        scheduler.release({ leaseId: lease.leaseId });
      }
    },
    stop() {
      running = false;
    }
  };
}
