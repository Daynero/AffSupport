import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/**
 * Reading the machine, and refusing to guess about it.
 *
 * The installed helper reports counters, not verdicts: cumulative CPU ticks, a
 * sleep-excluding uptime clock, native available memory, the kernel's own
 * pressure level, swap in use, free space on the destination volume. Every rate
 * this scheduler admits on is a difference between two readings, so the first
 * reading of a run can never grant admission — there is nothing to subtract it
 * from. That is the intended behaviour, not a bootstrap gap to paper over: a
 * missing mandatory signal waits.
 */

const PROBE_TIMEOUT_MS = 2000;
const MAX_PROBE_BYTES = 8 * 1024;
/** Wall clock outrunning the uptime clock by more than this means the machine slept. */
const SLEEP_SLACK_MS = 2000;
/** Enough readings to span the 30 s window at the 5 s sample interval. */
const WINDOW_READINGS = 7;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates the wire shape of one reading. Anything the helper could not read
 * is absent rather than zeroed, so an incomplete reading is rejected here and
 * surfaces as an unknown signal rather than a healthy-looking machine.
 */
export function parseReading(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const ticks = value.cpuTicks;
  if (!ticks || typeof ticks !== 'object') return null;
  const busy = ['user', 'system', 'nice'].map(key => finiteNumber(ticks[key]));
  const idle = finiteNumber(ticks.idle);
  if (idle === null || busy.some(tick => tick === null)) return null;
  const busyTicks = /** @type {number[]} */ (busy).reduce((total, tick) => total + tick, 0);
  const reading = {
    observedAt: typeof value.observedAt === 'string' ? value.observedAt : null,
    bootId: typeof value.bootId === 'string' ? value.bootId : null,
    uptimeNs: finiteNumber(value.uptimeNs),
    busyTicks,
    idleTicks: idle,
    availableBytes: finiteNumber(value.availableBytes),
    physicalBytes: finiteNumber(value.physicalBytes),
    pressure: typeof value.pressure === 'string' ? value.pressure : null,
    swapUsedBytes: finiteNumber(value.swapUsedBytes),
    diskFreeBytes: finiteNumber(value.diskFreeBytes),
    thermal: typeof value.thermal === 'string' ? value.thermal : null
  };
  if (Object.values(reading).some(field => field === null)) return null;
  if (!Number.isFinite(Date.parse(reading.observedAt))) return null;
  return Object.freeze(reading);
}

function runProbe(executable, volumePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, volumePath ? [volumePath] : [], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let text = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('PROBE_TIMEOUT'));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      text += chunk;
      if (text.length > MAX_PROBE_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('PROBE_OUTPUT_UNBOUNDED'));
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('PROBE_EXIT'));
      else resolve(text);
    });
  });
}

/**
 * Confirms the installed helper is the pinned one and still answers. A digest
 * mismatch is as fatal as a missing file: the runner never compiles a
 * replacement, so an unrecognised probe blocks every heavy step.
 */
export async function inspectInstalledProbe({ executable, digest, volumePath = '/' }) {
  try {
    await access(executable);
    const actual = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    if (actual !== digest) return { ok: false, code: 'PROBE_UNAVAILABLE', reason: 'digest_mismatch' };
    const reading = parseReading(JSON.parse(await runProbe(executable, volumePath)));
    if (!reading) return { ok: false, code: 'PROBE_UNAVAILABLE', reason: 'typed_output_invalid' };
    return { ok: true, value: reading };
  } catch {
    return { ok: false, code: 'PROBE_UNAVAILABLE', reason: 'missing_or_invalid' };
  }
}

/**
 * Turns a window of readings into the sample the admission policy consumes.
 *
 * `history` is oldest-first and already bounded to the window. Swap growth is
 * measured against the oldest retained reading rather than the previous one, so
 * a steady climb of small increments cannot slip under a per-sample threshold.
 */
export function deriveSample(history, reading) {
  const previous = history.at(-1) ?? null;
  const baseline = history[0] ?? null;
  const sample = {
    observedAt: reading.observedAt,
    bootId: reading.bootId,
    physicalBytes: reading.physicalBytes,
    availableBytes: reading.availableBytes,
    pressure: reading.pressure === 'unknown' ? null : reading.pressure,
    diskFreeBytes: reading.diskFreeBytes,
    thermal: reading.thermal,
    cpuPercent: null,
    swapGrowthBytes: null,
    sleep: false
  };
  if (!previous) return Object.freeze(sample);
  if (previous.bootId !== reading.bootId) return Object.freeze({ ...sample, sleep: true });
  const wallDeltaMs = Date.parse(reading.observedAt) - Date.parse(previous.observedAt);
  const uptimeDeltaMs = (reading.uptimeNs - previous.uptimeNs) / 1e6;
  const slept = wallDeltaMs - uptimeDeltaMs > SLEEP_SLACK_MS;
  const busy = reading.busyTicks - previous.busyTicks;
  const total = busy + (reading.idleTicks - previous.idleTicks);
  return Object.freeze({
    ...sample,
    sleep: slept,
    cpuPercent: total > 0 && busy >= 0 ? (busy / total) * 100 : null,
    swapGrowthBytes: Math.max(0, reading.swapUsedBytes - (baseline ?? previous).swapUsedBytes)
  });
}

/**
 * A stateful reader over the installed probe. It holds only the window it needs
 * and never retries a failed reading silently: a bad reading becomes an unknown
 * sample, which closes admission until a full clean window exists again.
 */
export function createProbeSampler({ executable, volumePath = '/', windowReadings = WINDOW_READINGS }) {
  const history = [];
  return {
    async sample() {
      let reading;
      try {
        reading = parseReading(JSON.parse(await runProbe(executable, volumePath)));
      } catch {
        reading = null;
      }
      if (!reading) {
        history.length = 0;
        return Object.freeze({
          observedAt: new Date().toISOString(),
          bootId: null,
          cpuPercent: null,
          availableBytes: null,
          pressure: null,
          swapGrowthBytes: null,
          diskFreeBytes: null,
          thermal: null,
          sleep: false
        });
      }
      const derived = deriveSample(history, reading);
      history.push(reading);
      while (history.length > windowReadings) history.shift();
      return derived;
    }
  };
}
