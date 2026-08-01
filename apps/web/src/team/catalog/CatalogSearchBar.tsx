import { useI18n } from '../../i18n';

export function CatalogSearchBar({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="team-catalog-search">
      <span>{t('teamCatalogSearch')}</span>
      <input
        type="search"
        value={value}
        placeholder={t('teamCatalogSearchPlaceholder')}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}
