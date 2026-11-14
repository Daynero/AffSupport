import { CATALOG_DEFERRED_PUBLICATION_AVAILABLE } from '../product-catalog/CatalogPublicationSchedule';
import { parseLaunchCatalogVideoConfig, type LaunchCatalogConfig } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import {
  CatalogCreationVideoFields,
  type CatalogCreationVideoDraft
} from '../product-catalog/CatalogCreationVideoFields';
import { resolveCatalogPublicationDraft } from '../product-catalog/catalogPublicationDraft';
import { launchPublicationTimePassed } from './launchPublicationTiming';
import { launchBrowserTimezone } from './launchTimezone';
export function LaunchCatalogVideoFields({
  value,
  onChange,
  disabled,
  part = 'all'
}: {
  value: LaunchCatalogConfig;
  onChange(value: LaunchCatalogConfig): void;
  disabled: boolean;
  part?: 'all' | 'variations' | 'publication';
}) {
  const { t } = useI18n();
  const publication = value.videoPublication;
  const scheduled = publication?.mode === 'scheduled' ? publication : null;
  const local = scheduled?.localDateTime ?? '';
  const [date = '', time = '12:00'] = local.split('T');
  const draft: CatalogCreationVideoDraft = {
    variationCount: String(value.videoVariationCount ?? 1),
    delayed: Boolean(scheduled),
    date,
    time,
    zone: scheduled?.timeZone ?? (launchBrowserTimezone() || 'Europe/Kyiv')
  };
  // A stored proof determines the fold occurrence; never silently switch offsets.
  if (scheduled?.resolvedOffset) {
    for (const choice of ['earlier', 'later'] as const) {
      try {
        const result = resolveCatalogPublicationDraft(
          { localDateTime: local, timeZone: draft.zone, choice },
          0
        );
        if (
          result.kind === 'resolved' &&
          result.publication.resolvedOffset === scheduled.resolvedOffset
        ) {
          draft.occurrence = choice;
          break;
        }
      } catch {
        /* Incomplete drafts remain editable. */
      }
    }
  }
  const update = (next: CatalogCreationVideoDraft) => {
    let videoPublication: NonNullable<LaunchCatalogConfig['videoPublication']> = {
      mode: 'immediate'
    };
    if (next.delayed) {
      const localDateTime = `${next.date}T${next.time}`;
      videoPublication = {
        mode: 'scheduled',
        localDateTime,
        timeZone: next.zone,
        resolvedOffset: '',
        dueAt: ''
      };
      try {
        const resolved = resolveCatalogPublicationDraft(
          { localDateTime, timeZone: next.zone, choice: next.occurrence },
          Date.now()
        );
        if (resolved.kind === 'resolved') videoPublication = resolved.publication;
      } catch {
        /* Full generation validation exposes the incomplete proof. */
      }
    }
    onChange({
      ...value,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: value.restitchEnabled ? Number(next.variationCount) : 1,
      videoPublication
    });
  };
  const invalid =
    value.catalogVideoProtocolVersion === 1 &&
    parseLaunchCatalogVideoConfig(
      { ...value, productCount: 400, restitchEnabled: false, videoVariationCount: 1 },
      true
    ) === null;
  const error =
    part === 'variations' || !CATALOG_DEFERRED_PUBLICATION_AVAILABLE
      ? null
      : launchPublicationTimePassed(value)
        ? 'catalogPublicationTimePassed'
        : invalid && scheduled && local !== 'T12:00'
          ? 'catalogPublicationInvalid'
          : null;
  return (
    <>
      <CatalogCreationVideoFields
        part={part}
        value={draft}
        onChange={update}
        restitch={value.restitchEnabled}
        productCount={value.productCount}
        disabled={disabled}
      />
      {error && (
        <div className="ui-field launch-publication-error">
          <p className="ui-field-error" role="alert">
            {t(error)}
          </p>
        </div>
      )}
    </>
  );
}
