import { createHash } from 'node:crypto';

/** Account names have a 40-character product limit; campaign namespaces can be longer. */
export function fixtureAccountName(namespace, run, variant) {
  if (
    typeof namespace !== 'string' ||
    !/^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(namespace) ||
    typeof run !== 'string' ||
    !/^[a-f0-9]{8}$/.test(run) ||
    typeof variant !== 'string' ||
    !/^[A-Za-z0-9_-]{1,12}$/.test(variant)
  )
    throw new Error('ACCEPTANCE_FIXTURE_NAME_INVALID');
  return `036-${createHash('sha256').update(namespace).digest('hex').slice(0, 8)}-${run}-${variant}`;
}
