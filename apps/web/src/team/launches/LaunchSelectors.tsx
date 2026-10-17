import { SelectMenu } from '../../components/ui/index';
import { useI18n } from '../../i18n';
export function LaunchSelector({
  id,
  label,
  value,
  options,
  onChange,
  onCreate,
  disabled = false
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  onCreate?: (value: string) => Promise<string | void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SelectMenu
      id={id}
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      onCreate={onCreate}
      disabled={disabled}
      placeholder={t('launchesSelect')}
      createLabel={text => t('launchesCreateValue', { value: text })}
      errorLabel={t('launchesInvalid')}
    />
  );
}
