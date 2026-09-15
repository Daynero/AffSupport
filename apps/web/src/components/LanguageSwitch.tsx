import { useI18n, type Language } from '../i18n';
import { SegmentedControl } from './ui/index';

/**
 * Two languages, one of which is on (021, T040).
 *
 * It was a pair of buttons carrying `aria-pressed`, which says "this toggle is
 * down" twice rather than "this is the one of two that is chosen". The
 * inventory's segmented control says the second thing, and it is the same
 * control the rest of the product uses for a choice of two or three.
 */
export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <SegmentedControl<Language>
      className={`language-switch ${compact ? 'language-switch-compact' : ''}`.trim()}
      label={t('language')}
      size={compact ? 'sm' : 'md'}
      value={language}
      onChange={setLanguage}
      options={[
        { value: 'en', label: 'EN' },
        { value: 'uk', label: 'UA' }
      ]}
    />
  );
}
