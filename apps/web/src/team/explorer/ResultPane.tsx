import type {
  CatalogMaterialItem,
  TeamAnalyticsStorage,
  TeamMaterialTagColor,
  TeamPermissions
} from '@video-compressor/shared';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { SearchResultActions } from '../catalog/SearchResultActions';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import type { CatalogOpeners } from '../catalog/TeamCatalog';
import { VideoTextActions } from '../library/VideoTextActions';
import { MaterialDetailCard } from '../materials/MaterialDetailCard';
import { resultKind } from './ResultList';

/**
 * The details pane for a search result (070, T023): the folder's own card, drawn from the
 * result itself. The pane used to go away the moment a search opened — it is fed folder rows,
 * and a result is not one (it has no provider id, no Drive version, no "thumbnail ready"), so
 * the only way to see a found file's details was to leave the search for its folder.
 *
 * The actions are the result's (`host: 'search-result'`), in full: «Показати в папці» among
 * them, which opens the folder with the file selected and leaves the way back to this search.
 */
export function ResultPane({
  material,
  folderName,
  picture,
  permissions,
  storageKind,
  canManageMetadata,
  browseClient,
  openers,
  onReveal,
  onCreateTask,
  onChanged,
  tagging,
  revision
}: {
  material: CatalogMaterialItem;
  folderName: string | null;
  picture: string | null;
  permissions: TeamPermissions;
  storageKind: TeamAnalyticsStorage | null;
  canManageMetadata: boolean;
  browseClient: FolderPickerClient;
  openers: CatalogOpeners;
  onReveal: (material: CatalogMaterialItem) => void;
  onCreateTask?: (material: CatalogMaterialItem) => void;
  onChanged: () => void;
  tagging?: {
    canTag: true;
    onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => void;
  };
  revision: number;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const facts = [
    material.geo ? `GEO: ${material.geo}` : null,
    material.language ? `${t('teamCatalogLanguage')}: ${material.language}` : null,
    material.offer ? `${t('teamCatalogOffer')}: ${material.offer}` : null,
    ...material.tags.map(tag => `#${tag}`)
  ].filter((fact): fact is string => fact !== null);

  return (
    <aside className="team-explorer-pane" aria-label={t('teamExplorerPaneLabel')}>
      <MaterialDetailCard
        key={material.id}
        className="team-explorer-pane-detail"
        material={{ ...material, kind: resultKind(material) }}
        folderName={folderName}
        picture={picture}
        revision={revision}
        tag={
          tagging
            ? { canTag: true, onChange: color => tagging.onSetTag(material, color) }
            : undefined
        }
        notes={
          /* What the catalog knows about it — the facets this search narrows by. */
          facts.length > 0 ? (
            <ul className="team-catalog-markers team-explorer-result-facts">
              {facts.map(fact => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          ) : null
        }
        actions={() => (
          <SearchResultActions
            className="team-explorer-pane-icons"
            material={material}
            permissions={permissions}
            storageKind={storageKind}
            browseClient={browseClient}
            destinationFolderId={material.parentFolderId ?? null}
            canManageMetadata={canManageMetadata}
            onChanged={onChanged}
            onPreview={openers.preview}
            onEditText={openers.editText}
            onProcess={openers.process}
            onEditMetadata={openers.editMetadata}
            onShowProvenance={openers.provenance}
            onCreateTask={onCreateTask}
            onReveal={onReveal}
          />
        )}
      />
      {material.category === 'video' && (
        <div className="team-explorer-pane-transcript">
          <p className="team-explorer-pane-transcript-title">{t('teamTranscriptSection')}</p>
          <VideoTextActions
            teamId={material.teamId}
            videoId={material.id}
            videoName={material.name}
            onCopied={variant =>
              push({ tone: 'success', text: t('textTranslationCopied', { variant }) })
            }
            compact
          />
        </div>
      )}
    </aside>
  );
}
