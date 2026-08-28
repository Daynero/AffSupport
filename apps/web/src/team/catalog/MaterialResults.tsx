import type {
  CatalogMaterialItem,
  CatalogSearchResponse,
  TeamAnalyticsStorage,
  TeamPermissions
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import { MaterialRowMenu } from './MaterialRowMenu';
import type { FolderPickerClient } from './FolderPicker';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';

/** Matches the page size `useCatalogSearch` requests. */
const PAGE_SIZE = 50;

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
  onChanged,
  browseClient,
  destinationFolderId = null,
  page,
  onPageChange,
  pathFor
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
  /** Reads the folder tree for the row menu's destination picker. */
  browseClient: FolderPickerClient;
  /** Folder these results sit in, when there is one; where a new version lands. */
  destinationFolderId?: string | null;
  /** 1-based page currently shown. */
  page: number;
  onPageChange: (page: number) => void;
  /** 011: the folder path of a result, when the caller can name it. */
  pathFor?: (material: CatalogMaterialItem) => string | null;
}) {
  const { t } = useI18n();
  if (error) return <p className="team-inline-error">{t('teamCatalogLoadFailed')}</p>;
  if (loading && !result) return <LabeledSkeleton label="teamCatalogLoadingResults" />;
  if (!result || result.items.length === 0) return <p>{t('teamCatalogEmpty')}</p>;

  // The request always asks for fifty; the envelope carries the true total.
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

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
                    {pathFor?.(material) && (
                      <span className="team-catalog-material-path">{pathFor(material)}</span>
                    )}
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
                <div className="team-catalog-secondary-actions">
                  <MaterialRowMenu
                    teamId={material.teamId}
                    material={material}
                    permissions={permissions}
                    browseClient={browseClient}
                    storageKind={storageKind}
                    onChanged={onChanged}
                    onEditText={() => onEditText(material)}
                    onProcess={() => onProcess(material)}
                    destinationFolderId={destinationFolderId ?? material.parentFolderId ?? null}
                    replaceMaterialId={material.id}
                    folderUploadLabel={t('teamCatalogAddFileToFolder')}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* Results were capped at fifty with nothing to press: everything past the
          first page was simply unreachable (finding F5). */}
      {pageCount > 1 && (
        <nav className="team-catalog-pager" aria-label={t('teamCatalogPagerLabel')}>
          <Button
            type="button"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            {t('teamCatalogPagerPrevious')}
          </Button>
          <span aria-live="polite">
            {t('teamCatalogPagerPosition', { page, total: pageCount })}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            {t('teamCatalogPagerNext')}
          </Button>
        </nav>
      )}
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
