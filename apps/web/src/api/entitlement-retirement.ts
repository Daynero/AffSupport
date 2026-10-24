/** Per-actor intents avoid cross-tab read/modify/write loss. No credential is stored. */
export const RETIREMENT_PREFIX = 'soty.native-retirement.v1.';
const REVISION_KEY = 'soty.native-identity-revision.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_INTENTS = 32;
const REQUEST_TIMEOUT_MS = 2_000;
let localRevision = 0;
let lane: Promise<void> = Promise.resolve();
// Storage may be disabled. Keep a bounded in-page fallback, but never call it durable.
const volatile = new Map<string, string>();
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const result = lane.then(run);
  lane = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
export function agentIdentityRevision(): string {
  let shared = '';
  try {
    shared = localStorage.getItem(REVISION_KEY) ?? '';
  } catch {
    /* in-page fence still applies */
  }
  return `${localRevision}:${shared}`;
}
function intents(): Map<string, string> {
  const pending = new Map(volatile);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RETIREMENT_PREFIX)) continue;
      const actor = key.slice(RETIREMENT_PREFIX.length);
      const value = localStorage.getItem(key);
      if (UUID.test(actor) && value && UUID.test(value)) pending.set(actor, value);
      if (pending.size > MAX_INTENTS) throw new Error('ENTITLEMENT_UNAVAILABLE');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTITLEMENT_UNAVAILABLE') throw error;
  }
  return pending;
}
async function acknowledge(actorId: string, intentId: string, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    // Auth context is also imported by pure route resolvers. Keep this module
    // free of browser transport initialization until an actual retirement request.
    // Intent/revision publication above the async lane remains synchronous.
    const { requestBody } = await import('./client');
    const reply: unknown = await requestBody(
      '/api/entitlement/logout',
      { actorId },
      'POST',
      controller.signal
    );
    if (
      !reply ||
      typeof reply !== 'object' ||
      !('cleared' in reply) ||
      typeof reply.cleared !== 'boolean'
    ) {
      throw new Error('ENTITLEMENT_UNAVAILABLE');
    }
    // cleared=false is authoritative: this native profile has no matching current actor.
    // Never erase a replacement intent created while this request was in flight.
    if (volatile.get(actorId) === intentId) volatile.delete(actorId);
    try {
      if (localStorage.getItem(RETIREMENT_PREFIX + actorId) === intentId)
        localStorage.removeItem(RETIREMENT_PREFIX + actorId);
    } catch {
      throw new Error('ENTITLEMENT_UNAVAILABLE');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
/** Intent publication is synchronous, so an in-flight token exchange sees the new fence. */
export function retireAgentActor(actorId: string): Promise<'confirmed' | 'pending' | 'unrecorded'> {
  if (!UUID.test(actorId)) return Promise.resolve('unrecorded');
  localRevision++;
  const intentId = crypto.randomUUID();
  let durable = false;
  try {
    const pending = intents();
    if (!pending.has(actorId) && pending.size >= MAX_INTENTS)
      throw new Error('ENTITLEMENT_UNAVAILABLE');
    localStorage.setItem(RETIREMENT_PREFIX + actorId, intentId);
    localStorage.setItem(REVISION_KEY, intentId);
    durable = true;
  } catch {
    /* still attempt immediate paired cleanup */
  }
  if (volatile.has(actorId) || volatile.size < MAX_INTENTS) volatile.set(actorId, intentId);
  return serialize(async () => {
    try {
      await acknowledge(actorId, intentId);
      return 'confirmed' as const;
    } catch {
      return durable ? ('pending' as const) : ('unrecorded' as const);
    }
  });
}
export function flushAgentRetirements(signal?: AbortSignal): Promise<boolean> {
  return serialize(async () => {
    const pending = intents();
    for (const [actor, intent] of pending) {
      try {
        await acknowledge(actor, intent, signal);
      } catch {
        throw new Error('ENTITLEMENT_UNAVAILABLE');
      }
    }
    return pending.size > 0;
  });
}
/** Network token exchange may overlap logout; publication may not. */
export function publishAgentIdentity<T>(
  revision: string,
  publish: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return serialize(async () => {
    if (revision !== agentIdentityRevision()) throw new Error('ENTITLEMENT_SIGNIN_REQUIRED');
    for (const [actor, intent] of intents()) {
      try {
        await acknowledge(actor, intent, signal);
      } catch {
        throw new Error('ENTITLEMENT_UNAVAILABLE');
      }
    }
    if (signal?.aborted) throw new Error('ENTITLEMENT_UNAVAILABLE');
    if (revision !== agentIdentityRevision()) throw new Error('ENTITLEMENT_SIGNIN_REQUIRED');
    const result = await publish();
    if (revision !== agentIdentityRevision()) throw new Error('ENTITLEMENT_SIGNIN_REQUIRED');
    if (signal?.aborted) throw new Error('ENTITLEMENT_UNAVAILABLE');
    return result;
  });
}
