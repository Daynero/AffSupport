import {
  parseTeamFileOperationResult,
  type TeamFileOperationResult
} from '@video-compressor/shared';

/** A fulfilled request is not proof that a hosted file mutation finished. */
export function requireCompletedFileOperation(value: unknown): TeamFileOperationResult {
  const result = parseTeamFileOperationResult(value);
  if (!result || !result.operationId.trim()) throw new Error('INVALID_RESPONSE');
  if (result.historicalReceipt || result.state !== 'succeeded')
    throw new Error('PROCESS_RESULT_UNCERTAIN');
  return result;
}
