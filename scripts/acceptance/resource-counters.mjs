const MAX_COUNTER = 18446744073709551615n;
const MAX_PRECISE_RATE_DELTA = BigInt(Number.MAX_SAFE_INTEGER);

/** @param {unknown} value */
function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= MAX_COUNTER) return parsed;
  }
  return null;
}

/** @param {unknown} input
 * @returns {{reason:string}|{value:bigint,epoch:string}}
 */
function observation(input) {
  if (input === null || input === undefined) return { reason: 'missing_measurement' };
  if (
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !['value', 'epoch'].includes(key))
  )
    return { reason: 'invalid_measurement' };
  const raw = Reflect.get(input, 'value');
  if (raw === null || raw === undefined) return { reason: 'missing_measurement' };
  const value = integer(raw);
  if (value === null) return { reason: 'invalid_measurement' };
  const epoch = Reflect.get(input, 'epoch');
  if (epoch === null || epoch === undefined) return { reason: 'epoch_missing' };
  if (typeof epoch !== 'string' || !/^[a-f0-9]{64}$/u.test(epoch))
    return { reason: 'invalid_epoch' };
  return { value, epoch };
}

/** Arithmetic only. Callers must separately verify target identity and the
 * source of each reset epoch; these observations grant no target authority.
 * Unknown counters never become measured zero. Large counter values remain
 * exact even when their difference is small enough for a numeric rate.
 * @param {unknown} before
 * @param {unknown} after
 * @param {unknown} elapsedMs Positive monotonic elapsed time, not wall time.
 */
export function resourceCounterDelta(before, after, elapsedMs) {
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    elapsedMs > Number.MAX_SAFE_INTEGER
  )
    return { status: 'unknown', reason: 'invalid_duration' };
  const first = observation(before);
  const last = observation(after);
  if ('reason' in first) return { status: 'unknown', reason: first.reason };
  if ('reason' in last) return { status: 'unknown', reason: last.reason };
  if (first.epoch !== last.epoch) return { status: 'unknown', reason: 'counter_reset' };
  if (last.value < first.value) return { status: 'unknown', reason: 'counter_decreased' };
  const delta = last.value - first.value;
  if (delta > MAX_PRECISE_RATE_DELTA)
    return {
      status: 'observed',
      delta: delta.toString(),
      perSecond: null,
      reason: 'rate_precision_limit'
    };
  const rate = delta === 0n ? 0 : Number(delta) / (elapsedMs / 1000);
  return Number.isFinite(rate)
    ? { status: 'observed', delta: delta.toString(), perSecond: rate }
    : {
        status: 'observed',
        delta: delta.toString(),
        perSecond: null,
        reason: 'rate_out_of_range'
      };
}
