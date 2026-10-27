import type { TranslationKey } from '../i18n';
import type { Translate } from '../components/ui';

const ERROR_MESSAGES: Record<string, TranslationKey> = {
  MODEL_REQUIRED: 'transcriptionModelTitle',
  FEATURE_RETIRED: 'transcriptionErrorTransition',
  UPDATE_PENDING: 'transcriptionErrorUpdatePending',
  TRANSITION_NOT_ALLOWED: 'transcriptionErrorTransition',
  SOURCE_NOT_LOCAL: 'transcriptionErrorSourceNotLocal',
  PAUSE_UNSUPPORTED: 'transcriptionErrorPauseUnsupported',
  PAUSE_RETRY: 'transcriptionErrorPauseRetry',
  MODEL_MISSING: 'transcriptionErrorModelMissing',
  'The transcription engine failed.': 'transcriptionErrorEngine',
  'The audio track could not be prepared.': 'transcriptionErrorExtract',
  'The transcript could not be saved to disk.': 'transcriptionErrorSave',
  'The saved transcript is missing or damaged.': 'transcriptionErrorDocument',
  'The transcription could not be completed.': 'transcriptionFailedTitle',
  'The speech model for this run is not installed.': 'transcriptionErrorModelMissing'
};

export function describeError(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const key = ERROR_MESSAGES[message];
  if (key) return t(key);
  // The agent's own sentences ("Choose one or more files to transcribe.") are short and
  // already user-facing; anything that looks like a code is not.
  if (message && message.length < 120 && /\s/u.test(message) && !/^[A-Z_]+$/u.test(message)) {
    return message;
  }
  return t('transcriptionFailedTitle');
}
