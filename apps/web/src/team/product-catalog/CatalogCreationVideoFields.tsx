import { useId } from 'react';
import { distributeVariations } from '@video-compressor/shared';
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
  part = 'all',
  creativeCopies,
  media
}: {
  media?: 'video' | 'image';
  value: CatalogCreationVideoDraft;
  onChange(value: CatalogCreationVideoDraft): void;
  restitch: boolean;
  productCount: number;
  disabled: boolean;
  /** Launches can keep variations visible while disclosing publication separately. */
  part?: 'all' | 'variations' | 'publication';
  /** 062: copies of each video when a Launch has several; variations then go round-robin. */
  creativeCopies?: readonly number[];
}) {
  const { t } = useI18n();
  const countId = useId();
  const change = (patch: Partial<CatalogCreationVideoDraft>) => onChange({ ...value, ...patch });
  const count = Number(value.variationCount);
  const minimum = creativeCopies && creativeCopies.length > 1 ? creativeCopies.length : 1;
  // No upper bound while the product count is itself invalid: it has its own error, and «from
  // 1 to 0 variations» said nothing true (next QA 2026-11-21).
  const productLimit =
    Number.isSafeInteger(productCount) && productCount >= 1 ? productCount : null;
  const tooFew = value.variationCount !== '' && Number.isInteger(count) && count < minimum;
  const invalid =
    value.variationCount !== '' &&
    (!Number.isInteger(count) ||
      count < minimum ||
      (productLimit !== null && count > productLimit));
  const split =
    minimum > 1 && !invalid && value.variationCount !== ''
      ? distributeVariations(creativeCopies!, count).join(' · ')
      : null;
  return (
    <>
      {part !== 'publication' && restitch && (
        <FormField
          label={t('catalogVideoVariationCount')}
          htmlFor={countId}
          error={
            tooFew
              ? t('launchVariationsAtLeastCreatives', { count: minimum })
              : invalid
                ? t('catalogVideoVariationLimit', { count: productLimit ?? productCount })
                : undefined
          }
        >
          <Input
            id={countId}
            inputMode="numeric"
            width="narrow"
            value={value.variationCount}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={split ? `${countId}-split` : undefined}
            onChange={event =>
              change({ variationCount: event.target.value.replace(/[^\d]/gu, '').slice(0, 3) })
            }
          />
          {/* Under the field, where its error would be: inside the label it ran on into the
              field's name — «Варіації відео Варіації роздаються…» (next, 2026-11-21). */}
          {split && (
            <p id={`${countId}-split`} className="ui-field-help">
              {t('launchDistributionVariationHint', { split })}
            </p>
          )}
        </FormField>
      )}
      {part !== 'variations' && (
        <CatalogPublicationFields
          value={value}
          onChange={change}
          disabled={disabled}
          media={media}
        />
      )}
    </>
  );
}
