import { performance } from 'node:perf_hooks';
import { summarizeAttempts } from './load-accounting.mjs';

/** Open-loop arrivals: a busy worker drops a scheduled offer instead of postponing its clock.
 * @param {{count:number, intervalMs:number, concurrency:number, warmup:number, timeoutMs:number, execute:(index:number, signal:AbortSignal)=>Promise<boolean>, signal?:AbortSignal, now?:()=>number, wait?:(ms:number, signal?:AbortSignal)=>Promise<unknown>}} options
 */
export async function runArrivals({
  count,
  intervalMs,
  concurrency,
  warmup,
  timeoutMs,
  execute,
  signal,
  now = () => performance.now(),
  wait = waitForArrival
}) {
  if (
    ![count, concurrency, warmup].every(Number.isSafeInteger) ||
    count < 1 ||
    count > 10000 ||
    concurrency < 1 ||
    concurrency > 16 ||
    warmup < 0 ||
    warmup >= count ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 1000 ||
    count * intervalMs > 600000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    throw new Error('ACCEPTANCE_LOAD_CONFIG_INVALID');
  const started = now();
  const samples = [];
  const pending = new Set();
  let stopped = false;
  for (let index = 0; index < count; index++) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const scheduledMs = index * intervalMs;
    const delay = started + scheduledMs - now();
    if (delay > 0) await wait(delay, signal);
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    if (pending.size >= concurrency) {
      samples.push({
        index,
        scheduledMs,
        completedMs: Math.max(scheduledMs, now() - started),
        warmup: index < warmup,
        outcome: 'dropped'
      });
      continue;
    }
    const controller = new AbortController();
    let finishAbort = () => {};
    const aborted = new Promise(resolve => {
      finishAbort = () => resolve('error');
    });
    const abort = () => {
      controller.abort();
      finishAbort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    let deadline;
    const timedOut = new Promise(resolve => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    const action = Promise.resolve()
      .then(() => execute(index, controller.signal))
      .then(
        correct => (correct === true ? 'success' : 'wrong_result'),
        () => 'error'
      );
    const work = Promise.race([action, timedOut, aborted])
      .then(outcome => {
        samples.push({
          index,
          scheduledMs,
          completedMs: Math.max(scheduledMs, now() - started),
          warmup: index < warmup,
          outcome
        });
      })
      .finally(() => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        pending.delete(work);
      });
    pending.add(work);
  }
  await Promise.all(pending);
  samples.sort((a, b) => a.index - b.index);
  return {
    samples,
    summary: summarizeAttempts(samples, timeoutMs),
    durationMs: now() - started,
    stopped,
    notOffered: count - samples.length
  };
}

function waitForArrival(ms, signal) {
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve(undefined);
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
