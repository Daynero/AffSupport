import { evaluateResetTarget } from '../../packages/shared/dist/environment.js';

/** This validates configuration only. A live marker/identity probe is additionally required. */
export function validateLocalTarget(input) {
  const reject = () => ({ ok: false, code: 'ACCEPTANCE_TARGET_UNSAFE' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
  if (
    input.kind !== 'local' ||
    input.environment !== 'beta' ||
    input.marker !== 'soty-acceptance' ||
    typeof input.namespace !== 'string' ||
    !/^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(input.namespace)
  )
    return reject();
  try {
    if (
      typeof input.authUrl !== 'string' ||
      typeof input.functionsUrl !== 'string' ||
      typeof input.databaseUrl !== 'string'
    )
      return reject();
    const auth = new URL(input.authUrl);
    const functions = new URL(input.functionsUrl);
    const db = new URL(input.databaseUrl);
    const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (
      !loopback.has(auth.hostname) ||
      auth.protocol !== 'http:' ||
      auth.port !== '54321' ||
      auth.pathname !== '/' ||
      auth.username ||
      auth.password ||
      auth.search ||
      auth.hash ||
      functions.origin !== auth.origin ||
      functions.pathname !== '/functions/v1' ||
      functions.username ||
      functions.password ||
      functions.search ||
      functions.hash ||
      !loopback.has(db.hostname) ||
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      db.port !== '54322' ||
      db.pathname !== '/postgres' ||
      db.search ||
      db.hash ||
      evaluateResetTarget(input.databaseUrl)
    )
      return reject();
    return { ok: true };
  } catch {
    return reject();
  }
}
