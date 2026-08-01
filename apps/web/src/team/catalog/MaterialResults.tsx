import type {
  CatalogMaterialItem,
  CatalogSearchResponse,
  TeamAnalyticsStorage,
  TeamPermissions
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import { MaterialActions } from './MaterialActions';

const FRESHNESS_COPY: Record<CatalogSearchResponse['catalogFreshness']['state'], TranslationKey> = {
  not_started: 'teamCatalogFreshnessNotStarted',
  scanning: 'teamCatalogFreshnessScanning',
  replaying: 'teamCatalogFreshnessReplaying',
  ready: 'teamCatalogFreshnessReady',
  failed: 'teamCatalogFreshnessFailed',
  unavailable: 'teamCatalogFreshnessUnavailable'
};

export function MaterialResults({
  result,
  loading,
  error,
  canManageMetadata,
  permissions,
  storageKind,
  onEditMetadata,
  onPreview,
  onEditText,
  onProcess,
  onShowProvenance,
  onChanged
}: {
  result: CatalogSearchResponse | null;
  loading: boolean;
  error: boolean;
  canManageMetadata: boolean;
  permissions: TeamPermissions;
  storageKind: TeamAnalyticsStorage | null;
  onEditMetadata: (material: CatalogMaterialItem) => void;
  onPreview: (material: CatalogMaterialItem) => void;
  onEditText: (material: CatalogMaterialItem) => void;
  onProcess: (material: CatalogMaterialItem) => void;
  onShowProvenance: (material: CatalogMaterialItem) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  if (error) return <p className="team-inline-error">{t('teamCatalogLoadFailed')}</p>;
  if (loading && !result) return <p aria-live="polite">…</p>;
  if (!result || result.items.length === 0) return <p>{t('teamCatalogEmpty')}</p>;

  return (
    <>
      <div className="team-catalog-result-heading">
        <strong>
          {result.total === 1
            ? t('teamCatalogCountOne')
            : t('teamCatalogCountMany', { count: result.total })}
        </strong>
        <small>{t(FRESHNESS_COPY[result.catalogFreshness.state])}</small>
      </div>
      <ul className="team-catalog-results">
        {result.items.map(material => (
          <li key={material.id}>
            <div className="team-catalog-material-main">
              <strong>{material.name}</strong>
              <span>
                {material.category ?? material.kind} ·{' '}
                {material.mimeType ?? material.fileExtension ?? '—'}
              </span>
              <small>
                {material.geo ?? t('teamCatalogUnfilled')} ·{' '}
                {material.language ?? t('teamCatalogUnfilled')}
                {material.offer ? ` · ${material.offer}` : ''}
              </small>
              <div className="team-catalog-markers">
                <span>{material.classificationSource}</span>
                {material.transcriptIngestState !== 'not_applicable' && (
                  <span>
                    {material.transcriptIngestState}
                    {material.transcriptTruncated
                      ? ` · ${t('teamCatalogTranscriptTruncated')}`
                      : ''}
                  </span>
                )}
                {material.lineage.hasSource && <span>{t('teamCatalogHasSource')}</span>}
                {material.lineage.hasDerivatives && <span>{t('teamCatalogHasDerivatives')}</span>}
                {material.lineage.isVersion && <span>{t('teamCatalogIsVersion')}</span>}
              </div>
            </div>
            <div className="team-catalog-material-actions">
              {material.kind === 'file' && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('teamCatalogPreviewFor', { name: material.name })}
                  onClick={() => onPreview(material)}
                >
                  {t('teamCatalogPreview')}
                </Button>
              )}
              {canManageMetadata && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('teamCatalogEditMetadataFor', { name: material.name })}
                  onClick={() => onEditMetadata(material)}
                >
                  {t('teamCatalogEditMetadata')}
                </Button>
              )}
              {(material.lineage.hasSource ||
                material.lineage.hasDerivatives ||
                material.lineage.isVersion) && (
                <Button type="button" variant="ghost" onClick={() => onShowProvenance(material)}>
                  {t('teamProvenanceTitle')}
                </Button>
              )}
            </div>
            <MaterialActions
              teamId={material.teamId}
              material={material}
              permissions={permissions}
              storageKind={storageKind}
              onChanged={onChanged}
              onEditText={() => onEditText(material)}
              onProcess={() => onProcess(material)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
