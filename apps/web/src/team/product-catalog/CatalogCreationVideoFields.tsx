import { useId } from 'react';
import { FormField, Input } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import {
  CatalogPublicationFields,
  type CatalogPublicationFieldsValue
} from './CatalogPublicationFields';
export interface CatalogCreationVideoDraft extends CatalogPublicationFieldsValue {
  variationCount: string;
}
export function CatalogCreationVideoFields({
  value,
  onChange,
  restitch,
  productCount,
  disabled,
  part = 'all'
}: {
  value: CatalogCreationVideoDraft;
  onChange(value: CatalogCreationVideoDraft): void;
  restitch: boolean;
  productCount: number;
  disabled: boolean;
  /** Launches can keep variations visible while disclosing publication separately. */
  part?: 'all' | 'variations' | 'publication';
}) {
  const { t } = useI18n();
  const countId = useId();
  const change = (patch: Partial<CatalogCreationVideoDraft>) => onChange({ ...value, ...patch });
  const count = Number(value.variationCount);
  const invalid =
    value.variationCount !== '' && (!Number.isInteger(count) || count < 1 || count > productCount);
  return (
    <>
      {part !== 'publication' && restitch && (
        <FormField
          label={t('catalogVideoVariationCount')}
          htmlFor={countId}
          error={invalid ? t('catalogVideoVariationLimit', { count: productCount }) : undefined}
        >
          <Input
            id={countId}
            inputMode="numeric"
            width="narrow"
            value={value.variationCount}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={event =>
              change({ variationCount: event.target.value.replace(/[^\d]/gu, '').slice(0, 3) })
            }
          />
        </FormField>
      )}
      {part !== 'variations' && (
        <CatalogPublicationFields value={value} onChange={change} disabled={disabled} />
      )}
    </>
  );
}
