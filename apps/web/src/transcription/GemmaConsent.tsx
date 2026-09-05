import { Checkbox, type Translate } from '../components/ui';

/**
 * The Gemma terms checkbox, written once.
 *
 * It appears wherever the translation model can be installed — the first-run prompt and
 * the viewer's translation column — and the two copies had drifted into two independent
 * `accepted` states, so agreeing in one place did not count in the other.
 */
export function GemmaConsent({
  checked,
  onChange,
  t
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  t: Translate;
}) {
  // The app's own checkbox mark, not the browser's fourteen-pixel square: this is the gate
  // on a two-gigabyte install, and it was the hardest thing on the card to find.
  return (
    <Checkbox
      className="transcription-gemma-consent"
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      label={
        <span>
          {t('transcriptionGemmaConsent')}{' '}
          <a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noreferrer">
            {t('transcriptionGemmaTerms')}
          </a>{' '}
          {t('transcriptionGemmaAnd')}{' '}
          <a
            href="https://ai.google.dev/gemma/prohibited_use_policy"
            target="_blank"
            rel="noreferrer"
          >
            {t('transcriptionGemmaPolicy')}
          </a>
          .
        </span>
      }
    />
  );
}
