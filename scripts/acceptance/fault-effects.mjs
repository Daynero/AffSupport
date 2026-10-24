import { setTimeout as delay } from 'node:timers/promises';
import { changeLocalFaultJournal } from './faults.mjs';
import { faultPhase } from './fault-model.mjs';
import { crashOwnedCheckpointFixture } from './fault-worker.mjs';

/** Internal effect executor. Control must be produced by a verified adapter,
 * never deserialized from a campaign descriptor. A failed fence always preserves
 * normal delivery; an unknown post-effect acknowledgement remains explicit.
 */
export async function executeResponseFault(kind, control, perform) {
  if (!['lost_acceptance_response', 'lost_status_response'].includes(kind))
    throw Error('ACCEPTANCE_FAULT_ADAPTER_KIND');
  const claimed = await control('claim');
  const real = await perform();
  if (!claimed.ok) return real;
  const started = await control('effect-start');
  if (!started.ok) return real;
  // The caller must confirm after catching the loss. Persisting observation here
  // would fabricate receipt if this process crashed immediately before throwing.
  throw Error('ACCEPTANCE_RESPONSE_LOST');
}

export async function executeDeliveryFault(entry, control, deliver) {
  const claimed = await control('claim');
  if (!claimed.ok) return { delivered: true, value: await deliver() };
  if (entry.kind === 'delayed_delivery') await delay(entry.delayMs);
  const started = await control('effect-start');
  if (!started.ok) return { delivered: true, value: await deliver() };
  if (entry.kind === 'missing_signal') {
    const observed = await control('observe');
    return { delivered: false, omitted: true, observationConfirmed: observed.ok };
  }
  const value = await deliver();
  const observed = await control('observe');
  return { delivered: true, value, observationConfirmed: observed.ok };
}

/** Verified operation-scoped factory. It has no production activation flag,
 * request header, provider credential or caller-provided authority boolean.
 */
export async function createLocalFaultAdapter(target, faultId, context) {
  const status = await changeLocalFaultJournal(target, { action: 'status', faultId });
  const entry = status.ok ? status.entries?.find(value => value.faultId === faultId) : null;
  if (
    !entry ||
    entry.expired ||
    entry.state !== 'armed' ||
    context.namespace !== target.namespace ||
    context.phase !== faultPhase(entry.kind) ||
    ['actorId', 'teamId', 'operationId', 'flowId'].some(key => context[key] !== entry[key])
  )
    throw Error('ACCEPTANCE_FAULT_ADAPTER_REFUSED');
  const control = transition =>
    changeLocalFaultJournal(target, {
      action: 'transition',
      faultId,
      context,
      transition
    });
  return Object.freeze({
    kind: entry.kind,
    confirmObservation: () => control('observe'),
    async response(perform) {
      if (!['lost_acceptance_response', 'lost_status_response'].includes(entry.kind))
        throw Error('ACCEPTANCE_FAULT_ADAPTER_KIND');
      return executeResponseFault(entry.kind, control, perform);
    },
    async delivery(deliver) {
      if (!['delayed_delivery', 'missing_signal'].includes(entry.kind))
        throw Error('ACCEPTANCE_FAULT_ADAPTER_KIND');
      return executeDeliveryFault(entry, control, deliver);
    },
    async provider(input, init) {
      return executeProviderFault(entry, control, input, init);
    },
    async crash(worker) {
      if (entry.kind !== 'worker_crash_after_checkpoint')
        throw Error('ACCEPTANCE_FAULT_ADAPTER_KIND');
      return crashOwnedCheckpointFixture(entry, control, worker);
    }
  });
}

/** Internal safe-read transport seam. The verified factory supplies control;
 * injected responses contain no provider token, cursor or payload.
 */
export async function executeProviderFault(entry, control, input, init, transport = fetch) {
  if (!['drive_429', 'expired_cursor'].includes(entry.kind))
    throw Error('ACCEPTANCE_FAULT_ADAPTER_KIND');
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const scoped =
    url.protocol === 'https:' &&
    url.hostname === 'www.googleapis.com' &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    method === 'GET' &&
    !url.searchParams.has('alt') &&
    (entry.kind === 'expired_cursor'
      ? url.pathname === '/drive/v3/files' && Boolean(url.searchParams.get('pageToken'))
      : /^\/drive\/v3\/(?:files(?:\/[A-Za-z0-9_-]+)?|changes)$/u.test(url.pathname));
  if (!scoped) return transport(input, init);
  if (!(await control('claim')).ok || !(await control('effect-start')).ok)
    return transport(input, init);
  // Consumer acknowledgement is explicit, after the real client handles it.
  return entry.kind === 'drive_429'
    ? new Response('{"error":{"code":429,"message":"acceptance scoped rate limit"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' }
      })
    : new Response(
        '{"error":{"code":400,"message":"acceptance scoped rejected page token","errors":[{"reason":"invalid","location":"pageToken","locationType":"parameter"}]}}',
        {
          status: 400,
          headers: { 'content-type': 'application/json' }
        }
      );
}
