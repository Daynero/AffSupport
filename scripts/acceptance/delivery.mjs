const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Bounded collector clock; receiving a signal alone never counts as delivered content. */
export class DeliveryLedger {
  constructor(receivers, offers) {
    if (
      !Array.isArray(receivers) ||
      receivers.length < 1 ||
      receivers.length > 16 ||
      receivers.some(r => typeof r !== 'string' || !/^[A-Z]{1,12}$/.test(r)) ||
      new Set(receivers).size !== receivers.length ||
      !Array.isArray(offers) ||
      offers.length < 1 ||
      offers.length > 10000 ||
      offers.some(
        o =>
          !o ||
          typeof o !== 'object' ||
          !Number.isSafeInteger(o.index) ||
          o.index < 0 ||
          typeof o.name !== 'string' ||
          !o.name ||
          o.name.length > 40
      ) ||
      new Set(offers.map(o => o.index)).size !== offers.length ||
      new Set(offers.map(o => o.name)).size !== offers.length
    )
      throw new Error('ACCEPTANCE_DELIVERY_INVALID');
    this.receivers = [...receivers];
    /** @type {Map<number, {name:string, id:string|null, observations:Map<string,{id:string,atMs:number}>}>} */
    this.offers = new Map(
      offers.map(o => [o.index, { name: o.name, id: null, observations: new Map() }])
    );
    this.names = new Map(offers.map(o => [o.name, o.index]));
  }

  accept(index, id) {
    const offer = this.offers.get(index);
    if (
      !offer ||
      typeof id !== 'string' ||
      !UUID.test(id) ||
      (offer.id !== null && offer.id !== id)
    )
      throw new Error('ACCEPTANCE_DELIVERY_INVALID');
    offer.id = id;
  }

  observe(receiver, rows, atMs) {
    if (
      !this.receivers.includes(receiver) ||
      !Array.isArray(rows) ||
      rows.length > 10000 ||
      !Number.isFinite(atMs) ||
      atMs < 0
    )
      throw new Error('ACCEPTANCE_DELIVERY_INVALID');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID.test(row.id))
        continue;
      const index = this.names.get(row.name);
      if (index === undefined) continue;
      const offer = this.offers.get(index);
      if (!offer) throw new Error('ACCEPTANCE_DELIVERY_INVALID');
      const previous = offer.observations.get(receiver);
      if (!previous || (previous.id !== offer.id && row.id === offer.id))
        offer.observations.set(receiver, { id: row.id, atMs });
    }
  }

  delivered(index) {
    const offer = this.offers.get(index);
    return !!offer?.id && this.receivers.every(r => offer.observations.get(r)?.id === offer.id);
  }

  /** Every offered action has one outcome per receiver, including drops and missing reads. */
  samples(attempts, timeoutMs) {
    if (
      !Array.isArray(attempts) ||
      attempts.length > this.offers.size ||
      attempts.some(a => !a || typeof a !== 'object') ||
      new Set(attempts.map(a => a.index)).size !== attempts.length ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    )
      throw new Error('ACCEPTANCE_DELIVERY_INVALID');
    return attempts.flatMap(attempt => {
      const offer = this.offers.get(attempt.index);
      if (
        !offer ||
        !Number.isFinite(attempt.scheduledMs) ||
        attempt.scheduledMs < 0 ||
        typeof attempt.warmup !== 'boolean' ||
        !['success', 'timeout', 'wrong_result', 'dropped', 'error'].includes(attempt.outcome)
      )
        throw new Error('ACCEPTANCE_DELIVERY_INVALID');
      return this.receivers.map(receiver => {
        const observed = offer.observations.get(receiver);
        const matched = !!offer.id && observed?.id === offer.id;
        const at = matched && observed ? observed.atMs : attempt.scheduledMs + timeoutMs;
        const outcome = ['dropped', 'wrong_result', 'error'].includes(attempt.outcome)
          ? attempt.outcome
          : matched && at >= attempt.scheduledMs && at - attempt.scheduledMs <= timeoutMs
            ? 'success'
            : 'timeout';
        return {
          receiver,
          index: attempt.index,
          scheduledMs: attempt.scheduledMs,
          completedMs: Math.max(at, attempt.scheduledMs),
          warmup: attempt.warmup,
          outcome
        };
      });
    });
  }
}
