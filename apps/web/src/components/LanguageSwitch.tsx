import { useI18n } from '../i18n';

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <div
      className={`language-switch ${compact ? 'language-switch-compact' : ''}`}
      aria-label={t('language')}
    >
      <button
        type="button"
        className={language === 'en' ? 'is-active' : ''}
        onClick={() => setLanguage('en')}
        aria-pressed={language === 'en'}
      >
        EN
      </button>
      <button
        type="button"
        className={language === 'uk' ? 'is-active' : ''}
        onClick={() => setLanguage('uk')}
        aria-pressed={language === 'uk'}
      >
        UA
      </button>
    </div>
  );
}
