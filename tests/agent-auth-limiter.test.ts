import { afterEach, describe, expect, it } from 'vitest';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent.js';

/**
 * The authentication-failure limiter, keyed by what was actually wrong.
 *
 * Every tab on the machine reaches the agent from the same loopback address. A tab left
 * open across a restart retries its stale token in a loop, and a limiter keyed by address
 * alone charged that loop to the whole machine: the tab that had just paired was refused
 * for a minute for what a different one was doing (032 A3). The budget is now per
 * `ip:sha256(token)[:8]`, and a request with the right token is never counted against —
 * nor refused by — it.
 */

const STALE_TOKEN = 'a-token-from-before-the-restart';
const ANOTHER_STALE_TOKEN = 'a-token-from-two-restarts-ago';

let agent: MinimalAgent | null = null;

afterEach(async () => {
  await agent?.stop();
  agent = null;
});

async function health(token: string | null) {
  return agent!.app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { host: '127.0.0.1:43120', ...(token === null ? {} : { 'x-session-token': token }) }
  });
}

describe('authentication-failure limiter', () => {
  it('does not refuse the tab with the valid token because another tab is looping on a stale one', async () => {
    agent = await startMinimalAgent();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      statuses.push((await health(STALE_TOKEN)).statusCode);
    }
    // The stale token is refused, then cooled down: twenty attempts free, the rest 429.
    expect(statuses.slice(0, 20).every(status => status === 401)).toBe(true);
    expect(statuses.slice(20).every(status => status === 429)).toBe(true);
    const cooled = await health(STALE_TOKEN);
    expect(cooled.json()).toEqual({ error: 'TOO_MANY_ATTEMPTS' });

    // Same address, right token: answered as if nothing had happened.
    const valid = await health(agent.token);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ instanceId: 'minimal-instance' });
  });

  it("keeps one stale token's streak from spending another's budget", async () => {
    agent = await startMinimalAgent();
    for (let attempt = 0; attempt < 25; attempt += 1) await health(STALE_TOKEN);
    expect((await health(STALE_TOKEN)).statusCode).toBe(429);
    // A different wrong token starts its own count — it is a different thing being wrong.
    expect((await health(ANOTHER_STALE_TOKEN)).statusCode).toBe(401);
  });

  it('counts a request with no token at all under its own key', async () => {
    agent = await startMinimalAgent();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1)
      statuses.push((await health(null)).statusCode);
    expect(statuses.slice(0, 20).every(status => status === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Neither a stale token nor the valid one shares that key.
    expect((await health(STALE_TOKEN)).statusCode).toBe(401);
    expect((await health(agent.token)).statusCode).toBe(200);
  });

  it('never counts a valid request, however many there are', async () => {
    agent = await startMinimalAgent();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect((await health(agent.token)).statusCode).toBe(200);
    }
  });
});
