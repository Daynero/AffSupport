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
  onCreateTask,
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
  onCreateTask?: (material: CatalogMaterialItem) => void;
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
        {result.items.map(material => {
          const isFolder = material.kind === 'folder';
          const typeLabel = catalogMaterialTypeLabel(material, t);
          const categoryGlyph = catalogMaterialGlyph(material);
          const hasMetadata = Boolean(
            material.geo || material.language || material.offer || material.tags.length
          );
          const hasSecondaryActions = isFolder
            ? permissions.upload
            : permissions.download || permissions.edit || permissions.process || permissions.delete;

          return (
            <li key={material.id} className="team-catalog-result-card">
              <div className="team-catalog-material-main">
                <div className="team-catalog-material-heading">
                  <span className="team-catalog-material-glyph" aria-hidden="true">
                    {categoryGlyph}
                  </span>
                  <div>
                    <strong>{material.name}</strong>
                    <span className="team-catalog-material-type">
                      {typeLabel}
                      {material.kind === 'file' && material.fileExtension
                        ? ` · ${material.fileExtension.toUpperCase()}`
                        : ''}
                      {material.sizeBytes !== null ? ` · ${formatBytes(material.sizeBytes)}` : ''}
                    </span>
                  </div>
                </div>
                <div className="team-catalog-markers team-catalog-material-metadata">
                  {material.geo && <span>GEO: {material.geo}</span>}
                  {material.language && (
                    <span>
                      {t('teamCatalogLanguage')}: {material.language}
                    </span>
                  )}
                  {material.offer && (
                    <span>
                      {t('teamCatalogOffer')}: {material.offer}
                    </span>
                  )}
                  {material.tags.map(tag => (
                    <span key={tag}>#{tag}</span>
                  ))}
                  {!hasMetadata && (
                    <span className="team-catalog-metadata-missing">
                      {t('teamCatalogMetadataIncomplete')}
                    </span>
                  )}
                </div>
                <div className="team-catalog-markers team-catalog-material-statuses">
                  {material.transcriptIngestState !== 'not_applicable' && (
                    <span>{catalogTranscriptStatus(material.transcriptIngestState, t)}</span>
                  )}
                  {material.transcriptTruncated && (
                    <span>{t('teamCatalogTranscriptTruncated')}</span>
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
                {onCreateTask && material.kind === 'file' && (
                  <Button type="button" variant="ghost" onClick={() => onCreateTask(material)}>
                    {t('creativeLibraryCreateTask')}
                  </Button>
                )}
              </div>
              {hasSecondaryActions && (
                <details className="team-catalog-secondary-actions">
                  <summary>{t('teamCatalogMoreActions')}</summary>
                  <MaterialActions
                    teamId={material.teamId}
                    material={material}
                    permissions={permissions}
                    storageKind={storageKind}
                    onChanged={onChanged}
                    onEditText={() => onEditText(material)}
                    onProcess={() => onProcess(material)}
                    folderUploadLabel={t('teamCatalogAddFileToFolder')}
                  />
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function catalogMaterialGlyph(material: CatalogMaterialItem): string {
  if (material.kind === 'folder') return '▰';
  if (material.kind === 'shortcut') return '↗';
  if (material.category === 'video') return '▶';
  if (material.category === 'image') return '▧';
  if (material.category === 'landing') return '◇';
  if (material.category === 'transcript') return '≡';
  if (material.category === 'archive') return '▦';
  return '▤';
}

function catalogMaterialTypeLabel(
  material: CatalogMaterialItem,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (material.kind === 'folder') return t('teamCatalogFolder');
  if (material.kind === 'shortcut') return t('teamCatalogShortcut');
  if (material.category === 'video') return t('teamCatalogCategoryVideo');
  if (material.category === 'image') return t('teamCatalogCategoryImage');
  if (material.category === 'landing') return t('teamCatalogCategoryLanding');
  if (material.category === 'transcript') return t('teamCatalogCategoryTranscript');
  if (material.category === 'archive') return t('teamCatalogCategoryArchive');
  return t('teamCatalogFile');
}

function catalogTranscriptStatus(
  state: CatalogMaterialItem['transcriptIngestState'],
  t: ReturnType<typeof useI18n>['t']
): string {
  if (state === 'full') return t('teamCatalogTranscriptReady');
  if (state === 'truncated') return t('teamCatalogTranscriptTruncated');
  if (state === 'pending') return t('teamCatalogTranscriptPending');
  if (state === 'invalid_encoding') return t('teamCatalogTranscriptInvalid');
  if (state === 'unavailable') return t('teamCatalogTranscriptUnavailable');
  return t('teamCatalogTranscriptNotAvailable');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
