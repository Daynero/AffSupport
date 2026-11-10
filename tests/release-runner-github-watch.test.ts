import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { WORKFLOW_TIMEOUT_MS, watchWorkflow } from '../scripts/lib/release/github-watch.mjs';
import { stepDefinition } from '../scripts/lib/release/steps.mjs';

it('allows the workflow job budgets plus time to allocate hosted runners', () => {
  const workflow = readFileSync('.github/workflows/release-windows.yml', 'utf8');
  const jobMinutes = [...workflow.matchAll(/^\s+timeout-minutes: (\d+)$/gm)].reduce(
    (total, match) => total + Number(match[1]),
    0
  );
  expect(jobMinutes).toBeGreaterThan(0);
  expect(WORKFLOW_TIMEOUT_MS).toBeGreaterThan(jobMinutes * 60_000);
});

it('emits only changed workflow states and terminates on final conclusion', async () => {
  const states: string[] = [];
  const responses = [
    { status: 'in_progress', conclusion: null, jobs: [] },
    { status: 'in_progress', conclusion: null, jobs: [] },
    { status: 'completed', conclusion: 'success', jobs: [] }
  ];
  const result = await watchWorkflow({
    read: async () => responses.shift()!,
    sleep: async () => {},
    onState: event => states.push(event.summary)
  });
  expect(result.ok).toBe(true);
  expect(states).toEqual(['in_progress', 'completed — success']);
});

it.each(['windows_smoke', 'publish'])(
  '%s keeps watching a successful workflow beyond the local download deadline',
  async stepId => {
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    try {
      const result = await watchWorkflow({
        read: async () =>
          elapsed < 40 * 60_000
            ? { status: 'in_progress', conclusion: null, jobs: [] }
            : { status: 'completed', conclusion: 'success', jobs: [] },
        sleep: async () => {
          elapsed += 10 * 60_000;
        }
      });
      expect(result.ok).toBe(true);
      expect(stepDefinition(stepId).timeoutMs).toBeGreaterThan(elapsed);
      expect(stepDefinition('manifest').timeoutMs).toBeLessThan(elapsed);
    } finally {
      clock.mockRestore();
    }
  }
);

it('rides out transient read failures instead of ending the watch', async () => {
  const errors: number[] = [];
  const responses: Array<() => unknown> = [
    () => ({ status: 'in_progress', conclusion: null, jobs: [] }),
    () => {
      throw new Error('net/http: TLS handshake timeout');
    },
    () => {
      throw new Error('read: connection reset by peer');
    },
    () => ({ status: 'completed', conclusion: 'success', jobs: [] })
  ];
  const result = await watchWorkflow({
    read: async () => responses.shift()!(),
    sleep: async () => {},
    onReadError: (_error, failures) => errors.push(failures)
  });
  expect(result.ok).toBe(true);
  expect(errors).toEqual([1, 2]);
});

it('gives up after a sustained outage, and at once on a run that does not exist', async () => {
  let reads = 0;
  const outage = await watchWorkflow({
    read: async () => {
      reads += 1;
      throw new Error('i/o timeout');
    },
    sleep: async () => {},
    maxReadFailures: 4
  });
  expect(outage).toMatchObject({ ok: false, error: 'WORKFLOW_UNREADABLE' });
  expect(reads).toBe(4);

  reads = 0;
  const missing = await watchWorkflow({
    read: async () => {
      reads += 1;
      throw new Error('failed to get run: HTTP 404: Not Found');
    },
    sleep: async () => {}
  });
  expect(missing).toMatchObject({ ok: false, error: 'WORKFLOW_UNREADABLE' });
  expect(reads).toBe(1);
});
