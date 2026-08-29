import { useEffect, useMemo, useState } from 'react';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamMaterialRow,
  TeamMaterialRowKind,
  ThumbnailSession
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatSize } from '../../format';
import { DRAG_TYPE, KIND_LABEL, KIND_REASON, previewSummary } from './rowKinds';
import { KindIcon } from './KindIcon';
import { RowActions, type RowActionsProps } from './RowActions';
import { useExplorer } from './ExplorerProvider';
import { useFolderPage, type FolderPageClient } from './useFolderPage';
import { useThumbnailSession, type ThumbnailSessionClient } from './useThumbnailSession';

/**
 * Tiles (011, FR-014/FR-016): a prepared image or video shows its provider
 * thumbnail through the team's one session; a landing shows the first segment
 * of its render; everything else shows its kind and, where Soty cannot open
 * it, the one-line reason. Nothing here asks the provider directly.
 */
export interface ContentGridClient extends FolderPageClient, ThumbnailSessionClient {
  listLandingRenders?: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  landingRenderImageUrl?: (artifact: RenderArtifactRef, segment: number) => string;
}

const RENDER_LABEL: Record<NonNullable<TeamMaterialRow['landingRender']>['state'], TranslationKey> =
  {
    ready: 'teamExplorerRenderReady',
    rendering: 'teamExplorerRenderRendering',
    stale: 'teamExplorerRenderStale',
    failed: 'teamExplorerRenderFailed',
    none: 'teamExplorerRenderNone'
  };

export function ContentGrid({
  client,
  revision = 0,
  kinds,
  onPreview,
  actions
}: {
  client: ContentGridClient;
  revision?: number;
  kinds?: TeamMaterialRowKind[];
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
}) {
  const { t } = useI18n();
  const { teamId, currentFolderId, openFolder, selectedId, select, selectedIds, toggleSelected } =
    useExplorer();
  const page = useFolderPage({ teamId, client, parentFolderId: currentFolderId, kinds, revision });
  const session = useThumbnailSession({ teamId, client });
  const landingIds = useMemo(
    () =>
      page.rows
        .filter(row => row.kind === 'landing' && row.landingRender?.state === 'ready')
        .map(row => row.id),
    [page.rows]
  );
  const [renders, setRenders] = useState<Map<string, RenderArtifactRef>>(new Map());

  // One render-token read per page of ready landings.
  useEffect(() => {
    if (landingIds.length === 0 || !client.listLandingRenders) {
      setRenders(new Map());
      return;
    }
    let active = true;
    void client
      .listLandingRenders(teamId, landingIds, 'default')
      .then(pointers => {
        if (!active) return;
        const next = new Map<string, RenderArtifactRef>();
        for (const pointer of pointers) {
          if (pointer.state === 'ready' && pointer.artifact)
            next.set(pointer.materialId, pointer.artifact);
        }
        setRenders(next);
      })
      .catch(() => {
        if (active) setRenders(new Map());
      });
    return () => {
      active = false;
    };
  }, [client, landingIds, teamId]);

  return (
    <section className="team-explorer-content" aria-labelledby="team-explorer-grid-title">
      <div className="team-explorer-content-heading">
        <h2 id="team-explorer-grid-title" className="visually-hidden">
          {t('teamMaterials')}
        </h2>
        {page.total !== null && (
          <p className="team-explorer-total" aria-live="polite">
            {t('teamExplorerTotal', { count: page.total })}
          </p>
        )}
      </div>
      {page.loading && page.rows.length === 0 && (
        <LabeledSkeleton label="teamMaterialsLoading" rows={4} />
      )}
      {page.error && <p className="team-inline-error">{t('teamExplorerLoadFailed')}</p>}
      {!page.loading && !page.error && page.rows.length === 0 && (
        <p className="team-explorer-muted">{t('teamExplorerEmpty')}</p>
      )}
      <ul className="team-explorer-grid" role="list">
        {page.rows.map(row => (
          <Tile
            key={row.id}
            row={row}
            session={session}
            client={client}
            render={renders.get(row.id) ?? null}
            selected={selectedId === row.id}
            checked={selectedIds.has(row.id)}
            onOpenFolder={openFolder}
            onSelect={select}
            onToggle={toggleSelected}
            onPreview={onPreview}
            actions={actions}
          />
        ))}
      </ul>
      {page.hasMore && (
        <Button
          type="button"
          variant="secondary"
          loading={page.loading}
          onClick={() => void page.loadMore()}
        >
          {t('teamExplorerLoadMore')}
        </Button>
      )}
    </section>
  );
}

function Tile({
  row,
  session,
  client,
  render,
  selected,
  checked,
  onOpenFolder,
  onSelect,
  onToggle,
  onPreview,
  actions
}: {
  row: TeamMaterialRow;
  session: ThumbnailSession | null;
  client: ContentGridClient;
  render: RenderArtifactRef | null;
  selected: boolean;
  checked: boolean;
  onOpenFolder: (folderId: string) => void;
  onSelect: (materialId: string | null) => void;
  onToggle: (materialId: string) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
}) {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [row.id, row.driveVersion]);

  const thumbnail =
    !broken && session && row.thumbnailReady && (row.kind === 'image' || row.kind === 'video')
      ? client.thumbnailUrl(session, row.id)
      : null;
  const renderImage =
    !broken && render && client.landingRenderImageUrl
      ? client.landingRenderImageUrl(render, 0)
      : null;
  const image = thumbnail ?? renderImage;
  // A landing's picture is its own render; Drive's thumbnail has nothing to
  // add, so "no thumbnail in Google Drive yet" under a rendered page is noise.
  const reason =
    KIND_REASON[row.kind] ??
    (row.kind !== 'landing' && row.previewState === 'unavailable' && row.previewReason
      ? (`teamExplorerThumbnail_${row.previewReason}` as TranslationKey)
      : undefined);

  const open = () => {
    if (row.kind === 'folder') onOpenFolder(row.driveFileId);
    else onPreview?.(previewSummary(row));
  };

  return (
    <li
      className={`team-explorer-tile is-${row.kind}${selected ? ' is-selected' : ''}${
        checked ? ' is-checked' : ''
      }`}
      aria-selected={selected}
      draggable={row.kind !== 'folder'}
      onDragStart={event => {
        event.dataTransfer.setData(DRAG_TYPE, row.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onSelect(row.id)}
    >
      <button
        type="button"
        className="team-explorer-tile-visual"
        aria-label={t('teamExplorerOpenNamed', { name: row.name })}
        onClick={event => {
          event.stopPropagation();
          onSelect(row.id);
          open();
        }}
        onDoubleClick={open}
      >
        {image ? (
          <img src={image} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span className="team-explorer-tile-icon" aria-hidden="true">
            <KindIcon kind={row.kind} />
          </span>
        )}
        {row.kind === 'video' && image && (
          <span className="team-explorer-tile-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M9 7.4v9.2l7.4-4.6z" fill="currentColor" />
            </svg>
          </span>
        )}
      </button>
      {/* Selection and the menu sit over the picture, the way every file
          manager puts them: out of the caption, where they competed with the
          name, and out of the flow, where the bare checkbox floated loose. */}
      <label
        className="team-explorer-tile-check"
        onClick={event => event.stopPropagation()}
        title={t('teamExplorerSelectNamed', { name: row.name })}
      >
        <input
          type="checkbox"
          aria-label={t('teamExplorerSelectNamed', { name: row.name })}
          checked={checked}
          onChange={() => onToggle(row.id)}
        />
        <span aria-hidden="true" />
      </label>
      {actions && row.kind !== 'folder' && (
        <div className="team-explorer-tile-actions" onClick={event => event.stopPropagation()}>
          <RowActions {...actions} row={row} />
        </div>
      )}
      <div className="team-explorer-tile-caption">
        <span className="team-explorer-tile-name" title={row.name}>
          {row.name}
        </span>
        <span className="team-explorer-tile-meta">
          {t(KIND_LABEL[row.kind])}
          {row.sizeBytes !== null && row.kind !== 'folder' ? ` · ${formatSize(row.sizeBytes)}` : ''}
        </span>
        {row.kind === 'landing' && row.landingRender && (
          <span className={`team-explorer-tile-render is-${row.landingRender.state}`}>
            {t(RENDER_LABEL[row.landingRender.state])}
          </span>
        )}
        {reason && <span className="team-explorer-tile-reason">{t(reason)}</span>}
      </div>
    </li>
  );
}
