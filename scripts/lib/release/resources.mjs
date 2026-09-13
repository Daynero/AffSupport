export function validateProfile(profile) {
  if (!profile || profile.sampleIntervalMs !== 5000 || profile.stableWindowMs !== 30000 || profile.maxHeavy !== 1) throw new Error('RESOURCE_PROFILE_INVALID');
  return Object.freeze(JSON.parse(JSON.stringify(profile)));
}

export function admission(sample, profile, reservation = { ramBytes: 0, diskBytes: 0 }) {
  const required = ['cpuPercent', 'availableBytes', 'pressure', 'swapGrowthBytes', 'diskFreeBytes', 'thermal', 'observedAt'];
  if (required.some(key => sample[key] === undefined || sample[key] === null)) return { ok: false, reason: 'RESOURCE_SIGNAL_UNKNOWN' };
  if (sample.cpuPercent > profile.maxCpuPercent || sample.pressure !== 'normal' || sample.swapGrowthBytes > profile.maxSwapGrowthBytes || ['serious', 'critical'].includes(sample.thermal)) return { ok: false, reason: 'RESOURCE_BUSY' };
  if (sample.availableBytes < profile.ramReserveBytes + reservation.ramBytes || sample.diskFreeBytes < profile.diskReserveBytes + reservation.diskBytes) return { ok: false, reason: 'RESOURCE_INSUFFICIENT' };
  return { ok: true };
}

const GIB = 1024 ** 3;
const gib = bytes => `${(bytes / GIB).toFixed(2)} GiB`;

/**
 * The same verdict `stableWindow` reaches, with the reason attached.
 *
 * `RESOURCE_WAIT` on its own has now cost two releases an hour each. It is true
 * -- the window is not stable -- and it is useless, because every condition
 * reaches it by the same door: a machine genuinely under load, a reservation
 * held by a process that no longer exists, a probe that stopped answering, a
 * laptop that slept. Waiting looks identical in all four, and only one of them
 * ever ends on its own.
 *
 * So the failing condition is named, with the numbers that decided it. Nothing
 * about the decision changes; what changes is that the journal can say whether
 * this release is being patient or stuck.
 */
export function windowVerdict(samples, profile, reservation = { ramBytes: 0, diskBytes: 0 }) {
  if (samples.length < 7)
    return { ok: false, code: 'WINDOW_TOO_SHORT', detail: `${samples.length} of 7 readings taken` };
  const ordered = [...samples].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const spanMs = Date.parse(ordered.at(-1).observedAt) - Date.parse(ordered[0].observedAt);
  if (spanMs < profile.stableWindowMs)
    return {
      ok: false,
      code: 'WINDOW_TOO_SHORT',
      detail: `${Math.round(spanMs / 1000)}s of ${Math.round(profile.stableWindowMs / 1000)}s measured`
    };
  for (const [index, sample] of ordered.entries()) {
    if (index > 0 && Date.parse(sample.observedAt) - Date.parse(ordered[index - 1].observedAt) > profile.sampleIntervalMs * 2)
      return { ok: false, code: 'WINDOW_GAP', detail: 'a reading arrived too late to count' };
    if (sample.sleep || sample.bootId !== ordered[0].bootId)
      return { ok: false, code: 'SLEEP_OR_REBOOT', detail: 'the machine slept or rebooted inside the window' };
    const verdict = admission(sample, profile, reservation);
    if (!verdict.ok) return { ok: false, code: verdict.reason, detail: whyRefused(sample, profile, reservation) };
  }
  return { ok: true };
}

/** The one sentence that says which number was short, and by how much. */
function whyRefused(sample, profile, reservation) {
  const unknown = ['cpuPercent', 'availableBytes', 'pressure', 'swapGrowthBytes', 'diskFreeBytes', 'thermal', 'observedAt']
    .filter(key => sample[key] === undefined || sample[key] === null);
  if (unknown.length) return `the probe reported no ${unknown.join(', ')}`;
  if (sample.cpuPercent > profile.maxCpuPercent)
    return `cpu ${sample.cpuPercent.toFixed(0)}% is over the ${profile.maxCpuPercent}% ceiling`;
  if (sample.pressure !== 'normal') return `memory pressure is ${sample.pressure}`;
  if (sample.swapGrowthBytes > profile.maxSwapGrowthBytes)
    return `swap grew ${gib(sample.swapGrowthBytes)} in the window, over ${gib(profile.maxSwapGrowthBytes)}`;
  if (['serious', 'critical'].includes(sample.thermal)) return `thermal state is ${sample.thermal}`;
  const ramNeeded = profile.ramReserveBytes + reservation.ramBytes;
  if (sample.availableBytes < ramNeeded)
    return `ram ${gib(sample.availableBytes)} available, ${gib(ramNeeded)} needed ` +
      `(${gib(profile.ramReserveBytes)} floor + ${gib(reservation.ramBytes)} reserved)`;
  const diskNeeded = profile.diskReserveBytes + reservation.diskBytes;
  if (sample.diskFreeBytes < diskNeeded)
    return `disk ${gib(sample.diskFreeBytes)} free, ${gib(diskNeeded)} needed ` +
      `(${gib(profile.diskReserveBytes)} floor + ${gib(reservation.diskBytes)} reserved)`;
  return 'the reading was refused without a distinguishing condition';
}

export function stableWindow(samples, profile, reservation = { ramBytes: 0, diskBytes: 0 }) {
  return windowVerdict(samples, profile, reservation).ok;
}

export function reservationFor(classProfile, { residentBytes = 0 } = {}) {
  if (!classProfile || !Number.isFinite(classProfile.ramBytes) || !Number.isFinite(classProfile.diskBytes)) throw new Error('RESOURCE_CLASS_INVALID');
  return Object.freeze({ ramBytes: Math.max(0, classProfile.ramBytes - residentBytes), diskBytes: classProfile.diskBytes });
}

/**
 * `standingReservation` is what the machine already owes to something resident
 * and unconsumed -- a beta stack that is up but idle, most of all. It is added
 * to whatever the next step wants, so a stack that has not yet grown into its
 * claim cannot be counted as free memory twice.
 */
/**
 * @param {object} profile
 * @param {object} leases
 * @param {{standingReservation?: (resourceClass?: string) => {ramBytes?: number, diskBytes?: number}}} [options]
 */
export function createResourceAdmission(
  profile,
  leases,
  { standingReservation = () => ({ ramBytes: 0, diskBytes: 0 }) } = {}
) {
  const samples = [];
  return {
    sample(value) { samples.push(value); if (samples.length > 7) samples.shift(); },
    request(request) {
      const classProfile = request.resourceClass ? profile.classes?.[request.resourceClass] : null;
      const standing = standingReservation(request.resourceClass);
      /**
       * A resident reservation is not paid for twice.
       *
       * `beta_stack` names one number for two different things: starting the
       * stack, and running a step that talks to one already up. When the stack
       * is resident it declares 3.2 GB, the class asks for 3.2 GB, and the sum
       * charges 6.4 GB for a stack that exists and is already using its half. On
       * a machine with three gigabytes free that is refused forever, in both
       * directions at once: the rehearsal needs the stack running, and the stack
       * running is what forbids the rehearsal.
       *
       * So a reservation that already covers its own class satisfies it. The
       * memory is spent; asking for it again asks the machine to have it twice.
       */
      const coversItsOwnClass =
        request.resourceClass === 'beta_stack' &&
        (standing.ramBytes ?? 0) >= (classProfile?.ramBytes ?? 0) &&
        (standing.diskBytes ?? 0) >= (classProfile?.diskBytes ?? 0);
      const reservation = coversItsOwnClass
        ? { ramBytes: 0, diskBytes: 0 }
        : {
            ramBytes: (standing.ramBytes ?? 0) + (classProfile?.ramBytes ?? 0),
            diskBytes: (standing.diskBytes ?? 0) + (classProfile?.diskBytes ?? 0)
          };
      const window = windowVerdict(samples, profile, reservation);
      if (!window.ok)
        return { ok: false, reason: 'RESOURCE_WAIT', code: window.code, detail: window.detail };
      return leases.request(request);
    },
    release(request) { return leases.release(request); }
  };
}

export function pressureDecision(samples, { owned, interruptible }) {
  const critical = samples.slice(-2).length === 2 && samples.slice(-2).every(sample => sample.pressure === 'critical');
  if (!critical) return { action: 'continue' };
  if (!owned) return { action: 'wait' };
  return interruptible ? { action: 'terminate_and_retry_once' } : { action: 'reconcile_boundary' };
}
