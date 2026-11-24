import { useState } from 'react';
import { isLanguageLoaded, loadLanguage } from '../dictionaries';
import { useI18n, type Language } from '../i18n';
import { SegmentedControl } from './ui/index';

/**
 * Two languages, one of which is on (021, T040).
 *
 * It was a pair of buttons carrying `aria-pressed`, which says "this toggle is
 * down" twice rather than "this is the one of two that is chosen". The
 * inventory's segmented control says the second thing, and it is the same
 * control the rest of the product uses for a choice of two or three.
 *
 * The second language is a download (070, T072): ~50–60 kB the first time.
 * On a slow line the switch used to sit unchanged until it arrived and looked
 * dead (070, T069). Now the choice moves at once and breathes until the words
 * are here; pointing at the switch starts the download before the click, so on
 * an ordinary line there is nothing to wait for. A failed download puts the
 * switch back.
 */
export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  const [pending, setPending] = useState<Language | null>(null);
  const other: Language = language === 'en' ? 'uk' : 'en';
  const warm = () => {
    if (!isLanguageLoaded(other)) void loadLanguage(other).catch(() => undefined);
  };
  const choose = (next: Language) => {
    if (next === language || isLanguageLoaded(next)) {
      setPending(null);
      setLanguage(next);
      return;
    }
    setPending(next);
    loadLanguage(next).then(
      () => {
        setPending(current => (current === next ? null : current));
        setLanguage(next);
      },
      () => setPending(current => (current === next ? null : current))
    );
  };
  return (
    <span className="contents" onPointerEnter={warm} onFocus={warm}>
      <SegmentedControl<Language>
        className={[
          'language-switch',
          compact ? 'language-switch-compact' : '',
          pending ? 'is-pending' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        label={t('language')}
        size={compact ? 'sm' : 'md'}
        value={pending ?? language}
        onChange={choose}
        options={[
          { value: 'en', label: 'EN' },
          { value: 'uk', label: 'UA' }
        ]}
      />
      {pending && (
        <span className="visually-hidden" role="status">
          {t('loading')}
        </span>
      )}
    </span>
  );
}
