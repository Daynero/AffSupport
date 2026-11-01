import type { AdminGrantTariffInput } from '../../api/team';

const PREFIX = 'soty.tariff-grant.v1:';
export class TariffGrantIntentError extends Error {
  constructor(readonly reason: 'pending' | 'storage') {
    super(reason);
  }
}
interface PendingGrant {
  operation: string;
  input: AdminGrantTariffInput;
}

/** Persist before sending. A lost response keeps the exact command for reconciliation. */
export function pendingTariffGrant(actor: string, storage?: Storage): PendingGrant | null {
  try {
    storage ??= localStorage;
    const raw = storage.getItem(PREFIX + actor);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingGrant;
    if (
      typeof value.operation !== 'string' ||
      !value.input ||
      typeof value.input.email !== 'string'
    )
      throw new Error('Invalid pending grant');
    return value;
  } catch {
    throw new TariffGrantIntentError('storage');
  }
}

export async function executeTariffGrant<T>(
  actor: string,
  input: AdminGrantTariffInput,
  send: (operation: string, input: AdminGrantTariffInput) => Promise<T>,
  definitiveRejection: (error: unknown) => boolean,
  storage?: Storage
): Promise<T> {
  try {
    storage ??= localStorage;
  } catch {
    throw new TariffGrantIntentError('storage');
  }
  const pending = pendingTariffGrant(actor, storage);
  if (pending && JSON.stringify(pending.input) !== JSON.stringify(input))
    throw new TariffGrantIntentError('pending');
  const intent = pending ?? { operation: crypto.randomUUID(), input };
  try {
    storage.setItem(PREFIX + actor, JSON.stringify(intent));
    if (storage.getItem(PREFIX + actor) !== JSON.stringify(intent))
      throw new Error('Not persisted');
  } catch {
    throw new TariffGrantIntentError('storage');
  }
  try {
    const result = await send(intent.operation, intent.input);
    storage.removeItem(PREFIX + actor);
    return result;
  } catch (error) {
    if (definitiveRejection(error)) storage.removeItem(PREFIX + actor);
    throw error;
  }
}
