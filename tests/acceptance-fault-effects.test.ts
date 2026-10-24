import { createServer, type Server } from 'node:http';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  executeResponseFault,
  executeDeliveryFault,
  createLocalFaultAdapter
} from '../scripts/acceptance/fault-effects.mjs';
let server: Server, url: string;
let commits = 0;
beforeAll(async () => {
  server = createServer((_request, response) => {
    commits++;
    response.end(JSON.stringify({ committed: commits }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_ADDRESS');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
});
it('loses a real loopback response only after the server has completed its work', async () => {
  const before = commits;
  const stages: string[] = [];
  await expect(
    executeResponseFault(
      'lost_acceptance_response',
      async (stage: string) => {
        stages.push(stage);
        return { ok: true };
      },
      () => fetch(url)
    )
  ).rejects.toThrow('ACCEPTANCE_RESPONSE_LOST');
  expect(commits).toBe(before + 1);
  expect(stages).toEqual(['claim', 'effect-start']);
});
it('preserves the actual response if clear or expiry wins while the request runs', async () => {
  const control = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
  const result = await executeResponseFault('lost_status_response', control, () => fetch(url));
  expect(result.status).toBe(200);
  expect(control).toHaveBeenCalledTimes(2);
});
it('does not fabricate consumer observation or replay a committed request', async () => {
  const before = commits;
  const control = vi
    .fn()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false });
  await expect(
    executeResponseFault('lost_acceptance_response', control, () => fetch(url))
  ).rejects.toThrow('ACCEPTANCE_RESPONSE_LOST');
  expect(commits).toBe(before + 1);
  expect(control).toHaveBeenCalledTimes(2);
});
it('omits only the notification callback while retaining an explicit missing-delivery outcome', async () => {
  const deliver = vi.fn();
  expect(
    await executeDeliveryFault({ kind: 'missing_signal' }, async () => ({ ok: true }), deliver)
  ).toEqual({ delivered: false, omitted: true, observationConfirmed: true });
  expect(deliver).not.toHaveBeenCalled();
});
it('delivers normally when a clear wins during the delay', async () => {
  const control = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
  const deliver = vi.fn().mockResolvedValue('receipt');
  expect(
    await executeDeliveryFault({ kind: 'delayed_delivery', delayMs: 5 }, control, deliver)
  ).toEqual({ delivered: true, value: 'receipt' });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(control).toHaveBeenCalledTimes(2);
});
it('marks delivery observed only after the actual callback succeeds', async () => {
  const stages: string[] = [];
  const control = async (stage: string) => {
    stages.push(stage);
    return { ok: true };
  };
  const deliver = async () => {
    stages.push('actual-delivery');
    return 'receipt';
  };
  expect(
    await executeDeliveryFault({ kind: 'delayed_delivery', delayMs: 1 }, control, deliver)
  ).toMatchObject({ delivered: true, observationConfirmed: true });
  expect(stages).toEqual(['claim', 'effect-start', 'actual-delivery', 'observe']);
});
it('never claims a failed callback as observed or retries it implicitly', async () => {
  const control = vi.fn().mockResolvedValue({ ok: true });
  const deliver = vi.fn().mockRejectedValue(Error('callback failed'));
  await expect(
    executeDeliveryFault({ kind: 'delayed_delivery', delayMs: 1 }, control, deliver)
  ).rejects.toThrow('callback failed');
  expect(control.mock.calls.map(call => call[0])).toEqual(['claim', 'effect-start']);
  expect(deliver).toHaveBeenCalledTimes(1);
});
it('refuses a forged production or caller-verified adapter before network access', async () => {
  await expect(
    createLocalFaultAdapter({ kind: 'production', verified: true }, 'forged', {})
  ).rejects.toThrow('ACCEPTANCE_FAULT_ADAPTER_REFUSED');
});
