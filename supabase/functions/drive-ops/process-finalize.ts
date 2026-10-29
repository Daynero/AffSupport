import { TeamFunctionError } from '../_shared/errors.ts';

/** Only a proved validation rejection is terminal; a lost commit reply stays uncertain. */
export async function finalizeProcessOutput<T>(
  finalize: () => Promise<T>,
  rejectSource: () => Promise<void>
): Promise<T> {
  try {
    return await finalize();
  } catch (error) {
    if (error instanceof TeamFunctionError && error.code === 'SOURCE_CHANGED') await rejectSource();
    throw error;
  }
}
