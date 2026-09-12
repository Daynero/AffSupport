export function summarizeWorkflowRun(run) {
  const active = (run.jobs ?? []).flatMap(job => (job.steps ?? []).filter(step => step.status === 'in_progress').map(step => `${job.name}: ${step.name}`)).join(' | ');
  return [run.status, run.conclusion, active].filter(Boolean).join(' — ');
}

/** @param {{read: () => Promise<any>, pollMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void>, onState?: (event: any) => void}} options */
export async function watchWorkflow({ read, pollMs = 30_000, timeoutMs = 180 * 60_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onState = () => {} }) {
  const started = Date.now(); let previous = '';
  while (Date.now() - started <= timeoutMs) {
    const run = await read(); const summary = summarizeWorkflowRun(run);
    if (summary !== previous) { onState({ summary, run }); previous = summary; }
    if (run.status === 'completed') return { ok: run.conclusion === 'success', run };
    await sleep(pollMs);
  }
  return { ok: false, error: 'WORKFLOW_TIMEOUT' };
}
