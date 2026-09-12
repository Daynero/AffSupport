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

export function stableWindow(samples, profile, reservation = { ramBytes: 0, diskBytes: 0 }) {
  if (samples.length < 7) return false;
  const ordered = [...samples].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (Date.parse(ordered.at(-1).observedAt) - Date.parse(ordered[0].observedAt) < profile.stableWindowMs) return false;
  return ordered.every((sample, index) => {
    if (index > 0 && Date.parse(sample.observedAt) - Date.parse(ordered[index - 1].observedAt) > profile.sampleIntervalMs * 2) return false;
    if (sample.sleep || sample.bootId !== ordered[0].bootId) return false;
    return admission(sample, profile, reservation).ok;
  });
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
export function createResourceAdmission(profile, leases, { standingReservation = () => ({ ramBytes: 0, diskBytes: 0 }) } = {}) {
  const samples = [];
  return {
    sample(value) { samples.push(value); if (samples.length > 7) samples.shift(); },
    request(request) {
      const classProfile = request.resourceClass ? profile.classes?.[request.resourceClass] : null;
      const standing = standingReservation();
      const reservation = {
        ramBytes: (standing.ramBytes ?? 0) + (classProfile?.ramBytes ?? 0),
        diskBytes: (standing.diskBytes ?? 0) + (classProfile?.diskBytes ?? 0)
      };
      if (!stableWindow(samples, profile, reservation)) return { ok: false, reason: 'RESOURCE_WAIT' };
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
