import { useState } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchResponse,
  TeamAnalyticsStorage,
  TeamMaterialTagColor,
  TeamPermissions
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import { SearchResultActions } from './SearchResultActions';
import type { FolderPickerClient } from './FolderPicker';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { TagDot } from '../explorer/TagDot';
import { useThumbnailSession, type ThumbnailSessionClient } from '../explorer/useThumbnailSession';
import { EmptyState, ErrorState } from '../../components/ui/index';

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

/** A stand-in so the hook's argument keeps its shape when nothing is supplied. */
const EMPTY_THUMBNAILS: ThumbnailSessionClient = {
  mintThumbnailSession: () => Promise.reject(new Error('NO_THUMBNAILS')),
  thumbnailUrl: () => ''
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
  onReveal,
  onChanged,
  browseClient,
  destinationFolderId = null,
  page,
  onPageChange,
  pathFor,
  tagging,
  thumbnails
}: {
  /**
   * The picture a result was missing (024, FR-090).
   *
   * A file found by search showed a category glyph while the same file in a
   * folder showed its thumbnail — so recognising it depended on how you had
   * looked for it, which is the whole of what US5 is about.
   */
  thumbnails?: ThumbnailSessionClient;
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
  /** Opens the file's folder in the explorer with the file selected. */
  onReveal?: (material: CatalogMaterialItem) => void;
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
  /** Present only for the space's owner: a tag is theirs alone to set (011). */
  tagging?: {
    canTag: true;
    onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => void;
  };
}) {
  const { t } = useI18n();
  /*
   * A search result is not a row this component owns — the page it belongs to
   * is held by the search — so a tag it just set is remembered here until the
   * next search answers with it. Without this the dot snapped back to its old
   * colour the moment React re-rendered the list.
   */
  const [justTagged, setJustTagged] = useState<Record<string, TeamMaterialTagColor | null>>({});
  /*
   * Every result in a page belongs to the same space, so one session serves
   * them all — and the hook caches it per team, so paging does not mint a
   * second.
   */
  const teamId = result?.items[0]?.teamId ?? null;
  const session = useThumbnailSession({
    teamId: teamId ?? '',
    client: thumbnails ?? EMPTY_THUMBNAILS,
    enabled: Boolean(teamId && thumbnails)
  });
  const thumbnail = (material: CatalogMaterialItem): string | null =>
    session && thumbnails && (material.category === 'image' || material.category === 'video')
      ? thumbnails.thumbnailUrl(session, material.id)
      : null;
  if (error)
    return <ErrorState className="team-inline-error" message={t('teamCatalogLoadFailed')} />;
  if (loading && !result) return <LabeledSkeleton label="teamCatalogLoadingResults" />;
  // Nothing matched. The search bar above is the control that changes that, so
  // the state says so rather than repeating it as a button.
  if (!result || result.items.length === 0) return <EmptyState title={t('teamCatalogEmpty')} />;

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
          const typeLabel = catalogMaterialTypeLabel(material, t);
          const categoryGlyph = catalogMaterialGlyph(material);
          const hasMetadata = Boolean(
            material.geo || material.language || material.offer || material.tags.length
          );
          return (
            <li key={material.id} className="team-catalog-result-card">
              <div className="team-catalog-material-main">
                <div className="team-catalog-material-heading">
                  <span className="team-catalog-material-glyph" aria-hidden="true">
                    {thumbnail(material) ? (
                      <img src={thumbnail(material)!} alt="" loading="lazy" decoding="async" />
                    ) : (
                      categoryGlyph
                    )}
                  </span>
                  <div>
                    <strong className="team-catalog-material-name">
                      <span title={material.name}>{material.name}</span>
                      {/* Beside the name, as in the explorer (024): beside the size it
                        read as part of the size and sat on its last letter. */}
                      <TagDot
                        color={
                          material.id in justTagged
                            ? justTagged[material.id]!
                            : (material.tagColor ?? null)
                        }
                        name={material.name}
                        canTag={Boolean(tagging)}
                        onChange={color => {
                          setJustTagged(current => ({ ...current, [material.id]: color }));
                          tagging?.onSetTag(material, color);
                        }}
                      />
                    </strong>
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
                {/* The note (024): a file found by a word of it should say so. */}
                {material.note && (
                  <p className="team-catalog-material-note" title={material.note}>
                    <span>{material.note.replace(/\n\s*\n+/gu, '\n')}</span>
                  </p>
                )}
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
              <SearchResultActions
                material={material}
                permissions={permissions}
                storageKind={storageKind}
                browseClient={browseClient}
                destinationFolderId={destinationFolderId ?? material.parentFolderId ?? null}
                canManageMetadata={canManageMetadata}
                onChanged={onChanged}
                onPreview={onPreview}
                onEditText={onEditText}
                onProcess={onProcess}
                onEditMetadata={onEditMetadata}
                onShowProvenance={onShowProvenance}
                onCreateTask={onCreateTask}
                onReveal={onReveal}
              />
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
