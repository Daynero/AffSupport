const epoch = 'a'.repeat(64);
const sample = value => ({ value, epoch });
const unknown = reason => ({ status: 'unknown', reason });

export const resourceCounterCases = [
  [
    'ordinary delta',
    sample('10'),
    sample('14'),
    2000,
    { status: 'observed', delta: '4', perSecond: 2 }
  ],
  [
    'observed zero',
    sample(10),
    sample('10'),
    1000,
    { status: 'observed', delta: '0', perSecond: 0 }
  ],
  [
    'precise large counters',
    sample('9007199254740993'),
    sample('9007199254740995'),
    1000,
    { status: 'observed', delta: '2', perSecond: 2 }
  ],
  [
    'counter reset',
    sample('10'),
    { value: '14', epoch: 'b'.repeat(64) },
    1000,
    unknown('counter_reset')
  ],
  ['unexplained decrease', sample('10'), sample('2'), 1000, unknown('counter_decreased')],
  ['missing first observation', null, sample(10), 1000, unknown('missing_measurement')],
  ['missing last value', sample(10), sample(null), 1000, unknown('missing_measurement')],
  ['missing epoch', sample(10), { value: 12, epoch: null }, 1000, unknown('epoch_missing')],
  ['invalid epoch', sample(10), { value: 12, epoch: 'unverified' }, 1000, unknown('invalid_epoch')],
  [
    'unsafe producer number',
    sample(0),
    sample(9007199254740992),
    1000,
    unknown('invalid_measurement')
  ],
  ['negative counter', sample(-1), sample(10), 1000, unknown('invalid_measurement')],
  [
    'counter exceeds uint64',
    sample(0),
    sample('18446744073709551616'),
    1000,
    unknown('invalid_measurement')
  ],
  ['fractional counter', sample(1.5), sample(10), 1000, unknown('invalid_measurement')],
  [
    'unexpected payload refused',
    sample(0),
    { value: 10, epoch, payload: 'never echo' },
    1000,
    unknown('invalid_measurement')
  ],
  ['zero duration', sample(0), sample(10), 0, unknown('invalid_duration')],
  ['backward duration', sample(0), sample(10), -1, unknown('invalid_duration')],
  ['infinite duration', sample(0), sample(10), Infinity, unknown('invalid_duration')],
  ['non-numeric duration', sample(0), sample(10), '1000', unknown('invalid_duration')],
  [
    'exact delta with unavailable rate',
    sample(0),
    sample('18446744073709551615'),
    1000,
    {
      status: 'observed',
      delta: '18446744073709551615',
      perSecond: null,
      reason: 'rate_precision_limit'
    }
  ],
  [
    'non-finite rate',
    sample(0),
    sample(1),
    Number.MIN_VALUE,
    { status: 'observed', delta: '1', perSecond: null, reason: 'rate_out_of_range' }
  ]
];
