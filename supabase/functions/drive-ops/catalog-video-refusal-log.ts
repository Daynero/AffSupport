/**
 * What refused a catalog video call, in words that are safe in a log.
 *
 * Production 2026-11-26: a creation stopped at «8 з 10» answered 409 on `admit` and 401 on every
 * call after it, and nothing said which check had refused: the functions return a closed code,
 * and several of them fold whatever the database said into PROCESS_RESULT_UNCERTAIN. Finding the
 * cause took the database's own log. One line here names the step, the database function and
 * what it answered.
 *
 * Only names, closed codes and the row ids already present in the request path are written:
 * never a ticket, a hash, a credential, or text the database composed.
 */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NAME = /^[a-z][a-z0-9_]{0,63}$/u;

export interface CatalogVideoRefusal {
  step: string;
  rpc: string | null;
  /** The closed code the database raised, or `UNRECOGNISED` for any other text. */
  answered: string;
  /** PostgreSQL's five-character class of the error, when it gave one. */
  sqlstate: string | null;
  setId: string | null;
  index: number | null;
}

export function describeCatalogVideoRefusal(
  step: string,
  rpc: string | null,
  error: unknown,
  scope: { setId?: unknown; index?: unknown } = {}
): CatalogVideoRefusal {
  const row = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof row.message === 'string' ? row.message : '';
  const code = typeof row.code === 'string' ? row.code : '';
  return {
    step: NAME.test(step) ? step : 'unknown',
    rpc: rpc !== null && NAME.test(rpc) ? rpc : null,
    answered: CODE.test(message) ? message : CODE.test(code) ? code : 'UNRECOGNISED',
    sqlstate: SQLSTATE.test(code) ? code : null,
    setId: typeof scope.setId === 'string' && UUID.test(scope.setId) ? scope.setId : null,
    index:
      typeof scope.index === 'number' && Number.isInteger(scope.index) && scope.index >= 0
        ? scope.index
        : null
  };
}

export function logCatalogVideoRefusal(
  step: string,
  rpc: string | null,
  error: unknown,
  scope: { setId?: unknown; index?: unknown } = {}
): void {
  try {
    console.warn(
      '[catalog-video] refused',
      JSON.stringify(describeCatalogVideoRefusal(step, rpc, error, scope))
    );
  } catch {
    /* A log line never changes the answer. */
  }
}
