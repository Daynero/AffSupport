// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import {
  executeTariffGrant,
  pendingTariffGrant
} from '../apps/web/src/pages/admin/tariffGrantIntent';
const input = {
  email: 'payer@test.invalid',
  plan: 'lead',
  endsOn: '2030-01-01',
  extraSeats: 0,
  teamId: null,
  note: null,
  externalRef: null,
  notify: false
};
beforeEach(() => localStorage.clear());
it('reuses the persisted command after an unknown result and module reload, then permits a new identical sale', async () => {
  const issued = new Map<string, string>();
  let lost = true;
  const send = vi.fn(async (operation: string) => {
    if (!issued.has(operation)) issued.set(operation, crypto.randomUUID());
    if (lost) {
      lost = false;
      throw new Error('response lost');
    }
    return issued.get(operation)!;
  });
  await expect(executeTariffGrant('admin', input, send, () => false)).rejects.toThrow(
    'response lost'
  );
  const original = pendingTariffGrant('admin')!;
  vi.resetModules();
  const reloaded = await import('../apps/web/src/pages/admin/tariffGrantIntent');
  await expect(reloaded.executeTariffGrant('admin', { ...input }, send, () => false)).resolves.toBe(
    issued.get(original.operation)
  );
  expect(issued.size).toBe(1);
  expect(pendingTariffGrant('admin')).toBeNull();
  await reloaded.executeTariffGrant('admin', input, send, () => false);
  expect(issued.size).toBe(2);
});
it('blocks another command while a result is unknown and never sends without durable storage', async () => {
  await expect(
    executeTariffGrant(
      'admin',
      input,
      async () => {
        throw new Error('lost');
      },
      () => false
    )
  ).rejects.toThrow('lost');
  const send = vi.fn();
  await expect(
    executeTariffGrant('admin', { ...input, extraSeats: 1 }, send, () => false)
  ).rejects.toThrow('pending');
  expect(send).not.toHaveBeenCalled();
  const unavailable = {
    getItem: () => null,
    setItem: () => {
      throw new Error('denied');
    }
  } as unknown as Storage;
  await expect(executeTariffGrant('admin', input, send, () => false, unavailable)).rejects.toThrow(
    'storage'
  );
  expect(send).not.toHaveBeenCalled();
});
it('releases a rejected intent for correction and isolates administrators', async () => {
  await expect(
    executeTariffGrant(
      'admin',
      input,
      async () => {
        throw new Error('invalid');
      },
      () => true
    )
  ).rejects.toThrow('invalid');
  expect(pendingTariffGrant('admin')).toBeNull();
  expect(pendingTariffGrant('another-admin')).toBeNull();
});
