export const FAULT_MARKER = 'soty.acceptance.faults.v1';
export const FAULT_KINDS = Object.freeze([
  'lost_acceptance_response',
  'lost_status_response',
  'drive_429',
  'expired_cursor',
  'worker_crash_after_checkpoint',
  'delayed_delivery',
  'missing_signal'
]);
const phases = Object.freeze({
  lost_acceptance_response: 'acceptance',
  lost_status_response: 'status',
  drive_429: 'provider',
  expired_cursor: 'provider-page',
  worker_crash_after_checkpoint: 'checkpoint',
  delayed_delivery: 'delivery',
  missing_signal: 'delivery'
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const namespacePattern = /^acceptance-[a-z0-9][a-z0-9-]{2,63}$/u;
const inputKeys = ['faultId', 'kind', 'actorId', 'teamId', 'operationId', 'flowId', 'ttlMs'];
const states = new Set(['armed', 'claimed', 'effect_started', 'observed', 'cleared']);
/** @param {unknown} value @returns {value is object} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const clock = value =>
  Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** @typedef {{namespace:string,faultId:string,kind:string,resourceKind:string,actorId:string,teamId:string,operationId:string|null,flowId:string,ttlMs:number,delayMs?:number}} FaultRequest */
/** @typedef {FaultRequest & {createdAtMs:number,expiresAtMs:number,changedAtMs:number,state:string}} FaultDescriptor */

/** Configuration only; the runtime must independently prove local fixture ownership.
 * @param {unknown} input
 * @param {unknown} namespace
 * @returns {{ok:true,value:FaultRequest}|{ok:false,code:'ACCEPTANCE_FAULT_INVALID'}}
 */
export function parseFaultRequest(input, namespace) {
  /** @returns {{ok:false,code:'ACCEPTANCE_FAULT_INVALID'}} */
  const reject = () => ({ ok: false, code: 'ACCEPTANCE_FAULT_INVALID' });
  try {
    if (typeof namespace !== 'string' || !namespacePattern.test(namespace) || !object(input))
      return reject();
    const kind = Reflect.get(input, 'kind');
    const keys = [
      ...inputKeys,
      ...(kind === 'delayed_delivery' ? ['delayMs'] : []),
      ...(Object.hasOwn(input, 'resourceKind') ? ['resourceKind'] : [])
    ];
    if (!exact(input, keys) || !FAULT_KINDS.includes(kind)) return reject();
    const resourceKind = Object.hasOwn(input, 'resourceKind')
      ? Reflect.get(input, 'resourceKind')
      : 'team_operation';
    if (!['team_operation', 'catalog_sync_request'].includes(resourceKind)) return reject();
    for (const key of ['faultId', 'actorId', 'teamId', 'operationId', 'flowId']) {
      const value = Reflect.get(input, key);
      if (key === 'operationId' && value === null && kind === 'lost_acceptance_response') continue;
      if (typeof value !== 'string' || !uuid.test(value)) return reject();
    }
    const ttlMs = Reflect.get(input, 'ttlMs');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) return reject();
    const delayMs = Reflect.get(input, 'delayMs');
    if (
      kind === 'delayed_delivery' &&
      (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > Math.min(ttlMs, 15000))
    )
      return reject();
    return {
      ok: true,
      value: {
        namespace,
        faultId: Reflect.get(input, 'faultId'),
        kind,
        resourceKind,
        actorId: Reflect.get(input, 'actorId'),
        teamId: Reflect.get(input, 'teamId'),
        operationId: Reflect.get(input, 'operationId'),
        flowId: Reflect.get(input, 'flowId'),
        ttlMs,
        ...(kind === 'delayed_delivery' ? { delayMs } : {})
      }
    };
  } catch {
    return reject();
  }
}

/** Pure descriptor creation. No network, worker or signal is modified here.
 * @param {unknown} input
 * @param {string} namespace
 * @param {number} nowMs
 * @returns {Readonly<FaultDescriptor>}
 */
export function armFaultDescriptor(input, namespace, nowMs) {
  const parsed = parseFaultRequest(input, namespace);
  if (!parsed.ok) throw Error(parsed.code);
  if (!clock(nowMs) || !clock(nowMs + parsed.value.ttlMs))
    throw Error('ACCEPTANCE_FAULT_CLOCK_INVALID');
  return Object.freeze({
    ...parsed.value,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + parsed.value.ttlMs,
    changedAtMs: nowMs,
    state: 'armed'
  });
}

/** A stored file is untrusted too; never repair a foreign descriptor in place. */
export function validateFaultDescriptor(input) {
  if (!object(input)) return false;
  const request = Object.fromEntries(inputKeys.map(key => [key, Reflect.get(input, key)]));
  if (Object.hasOwn(input, 'delayMs')) request.delayMs = Reflect.get(input, 'delayMs');
  if (Object.hasOwn(input, 'resourceKind'))
    request.resourceKind = Reflect.get(input, 'resourceKind');
  const parsed = parseFaultRequest(request, Reflect.get(input, 'namespace'));
  if (
    !parsed.ok ||
    !exact(input, [
      ...Object.keys(parsed.value),
      'createdAtMs',
      'expiresAtMs',
      'changedAtMs',
      'state'
    ])
  )
    return false;
  return (
    clock(input.createdAtMs) &&
    clock(input.expiresAtMs) &&
    clock(input.changedAtMs) &&
    input.expiresAtMs === input.createdAtMs + parsed.value.ttlMs &&
    input.changedAtMs >= input.createdAtMs &&
    states.has(input.state)
  );
}

/** Pure state transition; atomic persistence and actual effects belong to the runtime.
 * @param {FaultDescriptor} entry
 * @param {{namespace:string,actorId:string,teamId:string,operationId:string|null,flowId:string,phase:string}} context
 * @param {string} action
 * @param {number} nowMs
 * @returns {{ok:true,changed:boolean,entry:Readonly<FaultDescriptor>}|{ok:false,code:string}}
 */
export function transitionFault(entry, context, action, nowMs) {
  /** @param {string} code @returns {{ok:false,code:string}} */
  const reject = code => ({ ok: false, code });
  try {
    if (!validateFaultDescriptor(entry)) return reject('ACCEPTANCE_FAULT_INVALID');
    if (
      !exact(context, ['namespace', 'actorId', 'teamId', 'operationId', 'flowId', 'phase']) ||
      ['namespace', 'actorId', 'teamId', 'operationId', 'flowId'].some(
        key => context[key] !== entry[key]
      ) ||
      context.phase !== phases[entry.kind]
    )
      return reject('ACCEPTANCE_FAULT_SCOPE_MISMATCH');
    if (!clock(nowMs)) return reject('ACCEPTANCE_FAULT_CLOCK_INVALID');
    if (action === 'clear') {
      if (entry.state === 'cleared') return { ok: true, changed: false, entry };
      return {
        ok: true,
        changed: true,
        entry: Object.freeze({
          ...entry,
          state: 'cleared',
          changedAtMs: Math.max(nowMs, entry.changedAtMs)
        })
      };
    }
    if (nowMs < entry.changedAtMs) return reject('ACCEPTANCE_FAULT_CLOCK_INVALID');
    if (action === 'claim' && entry.state !== 'armed') return reject('ACCEPTANCE_FAULT_NOT_ACTIVE');
    if (['claim', 'effect-start'].includes(action) && nowMs >= entry.expiresAtMs)
      return reject('ACCEPTANCE_FAULT_EXPIRED');
    const next =
      action === 'claim' && entry.state === 'armed'
        ? 'claimed'
        : action === 'effect-start' && entry.state === 'claimed'
          ? 'effect_started'
          : action === 'observe' && entry.state === 'effect_started'
            ? 'observed'
            : null;
    if (!next) {
      if (action === 'observe' && entry.state === 'observed')
        return { ok: true, changed: false, entry };
      return reject('ACCEPTANCE_FAULT_TRANSITION_INVALID');
    }
    return {
      ok: true,
      changed: true,
      entry: Object.freeze({ ...entry, state: next, changedAtMs: nowMs })
    };
  } catch {
    return reject('ACCEPTANCE_FAULT_INVALID');
  }
}

/** Used only to clear already validated owned journal entries. */
export function faultPhase(kind) {
  if (!FAULT_KINDS.includes(kind)) throw Error('ACCEPTANCE_FAULT_INVALID');
  return phases[kind];
}
