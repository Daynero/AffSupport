// Validation (60m), Windows build (120m), and room for runner allocation (30m).
export const WORKFLOW_TIMEOUT_MS = 210 * 60_000;

export function summarizeWorkflowRun(run) {
  const active = (run.jobs ?? []).flatMap(job => (job.steps ?? []).filter(step => step.status === 'in_progress').map(step => `${job.name}: ${step.name}`)).join(' | ');
  return [run.status, run.conclusion, active].filter(Boolean).join(' — ');
}

/**
 * How many polls in a row may fail to reach GitHub before the watch gives up.
 *
 * The watch used to end on the first failed read, and the step with it: 1.4.0
 * stopped nine times on single TLS timeouts while the build it was watching
 * carried on untouched on GitHub. A failed read says nothing about the run, so
 * it is retried on the next poll; only a sustained outage (ten polls, about five
 * minutes at the default interval) or a run GitHub says does not exist ends it.
 */
export const MAX_CONSECUTIVE_READ_FAILURES = 10;
const FATAL_READ = /HTTP 404|Not Found|could not find|no such run/iu;

/** @param {{read: () => Promise<any>, pollMs?: number, timeoutMs?: number, maxReadFailures?: number, sleep?: (ms: number) => Promise<void>, onState?: (event: any) => void, onReadError?: (error: unknown, failures: number) => void}} options */
export async function watchWorkflow({ read, pollMs = 30_000, timeoutMs = WORKFLOW_TIMEOUT_MS, maxReadFailures = MAX_CONSECUTIVE_READ_FAILURES, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onState = () => {}, onReadError = () => {} }) {
  const started = Date.now(); let previous = ''; let failures = 0;
  while (Date.now() - started <= timeoutMs) {
    let run;
    try {
      run = await read();
      failures = 0;
    } catch (error) {
      failures += 1;
      onReadError(error, failures);
      const message = error instanceof Error ? error.message : String(error);
      if (FATAL_READ.test(message) || failures >= maxReadFailures)
        return { ok: false, error: 'WORKFLOW_UNREADABLE', detail: message };
      await sleep(pollMs);
      continue;
    }
    const summary = summarizeWorkflowRun(run);
    if (summary !== previous) { onState({ summary, run }); previous = summary; }
    if (run.status === 'completed') return { ok: run.conclusion === 'success', run };
    await sleep(pollMs);
  }
  return { ok: false, error: 'WORKFLOW_TIMEOUT' };
}
