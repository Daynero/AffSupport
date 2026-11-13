import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AgentUpdateCoordinator } from '../apps/agent/src/update/coordinator';
function fixture() {
  let busy = false;
  const resume = vi.fn();
  const flush = vi.fn(async () => {});
  const barrier = new AgentUpdateCoordinator(
    { busy: () => busy, flush, pauseAdmission: () => resume },
    n => n
  );
  return {
    barrier,
    resume,
    flush,
    setBusy: (value: boolean) => {
      busy = value;
    }
  };
}
describe('one update workload barrier', () => {
  it('waits for a preflight admitted before the first await', async () => {
    const f = fixture();
    const release = f.barrier.admission()!;
    const epoch = f.barrier.acquire('attempt');
    expect(f.barrier.admission()).toBe(null);
    const draining = f.barrier.drain('attempt', epoch, new AbortController().signal);
    await Promise.resolve();
    expect(f.flush).not.toHaveBeenCalled();
    f.setBusy(true);
    release();
    f.setBusy(false);
    await draining;
    expect(f.flush).toHaveBeenCalledOnce();
    f.barrier.release('attempt', epoch);
    expect(f.resume).toHaveBeenCalledOnce();
  });
  it('rechecks after asynchronous flush and rejects stale/committed defer', async () => {
    const f = fixture();
    const epoch = f.barrier.acquire('a');
    expect(() => f.barrier.release('a', 'stale')).toThrow('APP_UPDATE_WRONG_STATE');
    await f.barrier.drain('a', epoch, new AbortController().signal);
    f.barrier.commit('a', epoch);
    expect(() => f.barrier.release('a', epoch)).toThrow('APP_UPDATE_WRONG_STATE');
    f.barrier.releaseRejectedCommit('a', epoch);
    expect(f.barrier.accepting()).toBe(true);
  });
  it('never hands off a failed durable write', async () => {
    const f = fixture();
    f.flush.mockRejectedValueOnce(new Error('ENOSPC'));
    const epoch = f.barrier.acquire('a');
    await expect(f.barrier.drain('a', epoch, new AbortController().signal)).rejects.toThrow(
      'APP_UPDATE_FLUSH_FAILED'
    );
    expect(f.barrier.accepting()).toBe(false);
    f.barrier.release('a', epoch);
  });
  it('permits cancellation while refusing new HTTP work, and releases admitted requests', async () => {
    const f = fixture();
    const app = Fastify();
    f.barrier.registerAdmission(app);
    app.post('/api/run', async () => ({ ok: true }));
    app.post('/api/run/cancel', async () => ({ ok: true }));
    expect((await app.inject({ method: 'POST', url: '/api/run' })).statusCode).toBe(200);
    const epoch = f.barrier.acquire('a');
    expect((await app.inject({ method: 'POST', url: '/api/run' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/run/cancel' })).statusCode).toBe(200);
    await f.barrier.drain('a', epoch, new AbortController().signal);
    await app.close();
  });
});
