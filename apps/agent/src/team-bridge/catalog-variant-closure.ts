import {
  RECOVERY_PREUPLOAD_FAILURE_CODES,
  STITCH_ERROR_CODES,
  type TeamFileOperationResult
} from '@video-compressor/shared';
const preupload = new Set<string>([
  ...RECOVERY_PREUPLOAD_FAILURE_CODES,
  ...STITCH_ERROR_CODES,
  'RESTITCH_SCREEN_SELECTION_LIMIT',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_INVALID',
  'SOURCE_CHANGED',
  'PERMISSION_DENIED',
  'RESTITCH_SOURCE_FORBIDDEN',
  'UNSUPPORTED_MEDIA',
  'PROCESS_FAILED',
  'TOO_LARGE'
]);
/** Waits between deliveries of a terminal report whose reply was lost. */
export const TERMINAL_REPORT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 60_000, 60_000, 60_000
];
/** Answers that end the delivery: the server has decided, or refuses this agent. */
const TERMINAL_REPORT_FINAL = new Set([
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'WRONG_STATE',
  'NOT_FOUND',
  'AGENT_UPDATE_REQUIRED',
  'REQUEST_REUSE_CONFLICT'
]);
/** Called around the SAME bridge promise. Its finally has already drained local
 * work before this closure-only bookkeeping can make the original op terminal.
 *
 * A known pre-upload failure is reported until the server answers it: the
 * native closure's finish is refused while the operation still runs. Beta
 * 2026-11-11 (set ee5595a8): the report went out once into a paused gateway,
 * finish answered 409 for five minutes and the heartbeat kept the dead stitch
 * looking alive. An uncertain stop or an unrecognized failure is still never
 * reported (an upload may exist the server cannot see); the heartbeat stops
 * with the stitch, so the server's silence takeover settles it. */
export async function settleCatalogVariantProcess(input: {
  operationId: string;
  signal: AbortSignal;
  run: () => Promise<TeamFileOperationResult>;
  complete: (outcome: 'canceled' | 'failed', code: string) => Promise<Record<string, unknown>>;
  /** Fresh exact-child metadata; never inferred from elapsed time or local idleness. */
  cancellationRequested?: () => Promise<boolean>;
  /** The local stitch has ended, whatever its result: stop its heartbeat now. */
  ended?: () => void;
  /** Test seam: waits between repeated terminal reports. */
  reportDelaysMs?: readonly number[];
}): Promise<TeamFileOperationResult> {
  let result: TeamFileOperationResult;
  try {
    result = await input.run();
  } catch (error) {
    input.ended?.();
    const reason = input.signal.reason;
    if (reason instanceof Error && reason.message === 'PROCESS_RESULT_UNCERTAIN')
      throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: error });
    let code = error instanceof Error ? error.message : '';
    if (
      code !== 'PROCESS_CANCELED' &&
      input.cancellationRequested &&
      (await input.cancellationRequested().catch(() => false))
    )
      code = 'PROCESS_CANCELED';
    if (code !== 'PROCESS_CANCELED' && !preupload.has(code)) throw error;
    let settled: Record<string, unknown>;
    try {
      settled = await report(input, code === 'PROCESS_CANCELED' ? 'canceled' : 'failed', code);
    } catch (cause) {
      throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: cause ?? error });
    }
    if (settled.operationId !== input.operationId)
      throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: error });
    if (settled.kind === 'registered' && typeof settled.outputId === 'string')
      return {
        operationId: input.operationId,
        state: 'succeeded',
        materialId: settled.outputId,
        reused: true
      };
    if (settled.kind === 'terminal' && (settled.state === 'canceled' || settled.state === 'failed'))
      throw new Error(settled.state === 'canceled' ? 'PROCESS_CANCELED' : code, { cause: error });
    throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: error });
  }
  input.ended?.();
  return result;
}
/** Delivers the terminal report until the server answers it. It is idempotent:
 * an operation already terminal or registered is answered as such. */
async function report(
  input: Parameters<typeof settleCatalogVariantProcess>[0],
  outcome: 'canceled' | 'failed',
  code: string
) {
  const delays = input.reportDelaysMs ?? TERMINAL_REPORT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.complete(outcome, code);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (TERMINAL_REPORT_FINAL.has(message) || attempt >= delays.length) throw error;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delays[attempt]);
        timer.unref?.();
      });
    }
  }
}
