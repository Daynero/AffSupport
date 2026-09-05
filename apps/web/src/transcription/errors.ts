import type { TranslationKey } from '../i18n';
import type { Translate } from '../components/ui';

/**
 * The words a person sees for a failure the agent named.
 *
 * Codes are stable and translatable; the agent's prose is neither, and a toast that said
 * `TRANSLATOR_UNAVAILABLE` in capitals was the tool shouting at the reader in a language
 * it never learned. The agent's own sentences are listed too: a row that failed used to
 * print them as they came, in English whatever the interface language.
 */
const ERROR_MESSAGES: Record<string, TranslationKey> = {
  MODEL_REQUIRED: 'transcriptionModelTitle',
  UPDATE_PENDING: 'transcriptionErrorUpdatePending',
  TRANSITION_NOT_ALLOWED: 'transcriptionErrorTransition',
  TRANSLATOR_UNAVAILABLE: 'transcriptionTranslationUnavailable',
  TRANSLATION_NOT_READY: 'transcriptionErrorTranslationNotReady',
  SOURCE_NOT_LOCAL: 'transcriptionErrorSourceNotLocal',
  SAVE_FAILED: 'transcriptionSaveWithTranslationFailed',
  PAUSE_UNSUPPORTED: 'transcriptionErrorPauseUnsupported',
  PAUSE_RETRY: 'transcriptionErrorPauseRetry',
  MODEL_SOURCE_NOT_CONFIGURED: 'transcriptionTranslatorNotConfigured',
  MODEL_MISSING: 'transcriptionErrorModelMissing',
  'The transcription engine failed.': 'transcriptionErrorEngine',
  'The audio track could not be prepared.': 'transcriptionErrorExtract',
  'The transcript could not be saved to disk.': 'transcriptionErrorSave',
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
