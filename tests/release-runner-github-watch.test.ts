import { expect, it } from 'vitest';
import { watchWorkflow } from '../scripts/lib/release/github-watch.mjs';

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
