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
/** Called around the SAME bridge promise. Its finally has already drained local
 * work before this closure-only bookkeeping can make the original op terminal. */
export async function settleCatalogVariantProcess(input: {
  operationId: string;
  signal: AbortSignal;
  run: () => Promise<TeamFileOperationResult>;
  complete: (outcome: 'canceled' | 'failed', code: string) => Promise<Record<string, unknown>>;
  /** Fresh exact-child metadata; never inferred from elapsed time or local idleness. */
  cancellationRequested?: () => Promise<boolean>;
}): Promise<TeamFileOperationResult> {
  try {
    return await input.run();
  } catch (error) {
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
    const settled = await input.complete(code === 'PROCESS_CANCELED' ? 'canceled' : 'failed', code);
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
}
