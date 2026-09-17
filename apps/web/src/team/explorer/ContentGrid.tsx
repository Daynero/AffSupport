import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamMaterialRow,
  ThumbnailSession
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { EmptyState, ErrorState } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { FolderOpen, Paperclip } from 'lucide-react';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useI18n, type TranslationKey } from '../../i18n';
import { displayedSize, formatDate } from '../../format';
import { KIND_LABEL, KIND_REASON, previewSummary } from './rowKinds';
import { KindIcon } from './KindIcon';
import { KindNote } from './KindNote';
import { companionOf } from './companions';
import { useMaterialDrag } from './materialDrag';
import { RowActions, type RowActionsProps } from './RowActions';
import { useExplorer } from './ExplorerProvider';
import { MorePages } from './MorePages';
import { TagDot } from './TagDot';
import type { TaggingProps } from './ContentList';
import type { FolderPageClient, FolderPageState } from './useFolderPage';
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
  page,
  rows = page.rows,
  onPreview,
  actions,
  tagging,
  emptyAction,
  onDropMaterials,
  companionCounts,
  openedCompanions,
  onToggleCompanions
}: {
  client: ContentGridClient;
  /** The folder's rows, held by the shell so one listing serves everything. */
  page: FolderPageState;
  /**
   * The rows to draw, already in order (024).
   *
   * The shell sorts once — it has to, because the arrow keys walk the list in
   * the order the reader sees — and this used to sort the same array again on
   * every render with the same comparator. Two sorts that agreed by accident:
   * the day they stopped agreeing, Down would have moved to a different row
   * from the one below.
   *
   * Defaults to the page's own rows so this view can still be rendered on its
   * own — by a test, or by a surface that has no sort of its own — without
   * having to know what order the shell would have put them in.
   */
  rows?: readonly TeamMaterialRow[];
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
  /** Present only for the space's owner (011). */
  tagging?: TaggingProps;
  /**
   * The control that fills an empty folder — the shell's own Add files, since
   * that is where the file input lives. Absent for a member who may not upload,
   * which is the same rule as the toolbar's (FR-021, FR-004).
   */
  emptyAction?: ReactNode;
  /** How many companions each video holds, folded away until opened (024, US25). */
  companionCounts?: ReadonlyMap<string, number>;
  openedCompanions?: ReadonlySet<string>;
  onToggleCompanions?: (rowId: string) => void;
  /** Files dropped on a folder here move into it; absent for a reader who may not move them. */
  onDropMaterials?: (folderDriveId: string, materialIds: string[]) => void;
}) {
  const { t } = useI18n();
  const { teamId, openFolder, selectedId, select, selectedIds, toggleSelected } = useExplorer();
  const drag = useMaterialDrag({ selectedIds, rows, onDropMaterials });
  /*
   * The page comes from the shell, which is the only place that can hold it:
   * this component used to run its own `useFolderPage` with the same arguments,
   * so every folder was listed twice and only this copy ever paged. Everything
   * the shell decides — the preview pane, the arrow keys, Delete, the upload's
   * name-clash check — read the shell's copy, which stopped at the first
   * hundred rows and never grew.
   */
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
        {/* No "Items: N" (024, FR-096): the tree beside it already counts the folder. */}
      </div>
      {page.loading && page.rows.length === 0 && (
        <LabeledSkeleton label="teamMaterialsLoading" rows={4} />
      )}
      {page.error && <ErrorState message={t('teamExplorerLoadFailed')} />}
      {/* One sentence, centred in a content area that keeps its shape. It was
          "Елементів: 0" and "Ця папка порожня." stacked flush left, saying the
          same thing twice above a card that had collapsed to a strip. */}
      {!page.loading && !page.error && page.rows.length === 0 && (
        <EmptyState
          className="team-explorer-empty"
          icon={<FolderOpen size={26} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          title={t('teamExplorerEmpty')}
          action={emptyAction}
        />
      )}
      <ul className="team-explorer-grid" role="list">
        {rows.map(row => (
          <Tile
            key={row.id}
            row={row}
            session={session}
            client={client}
            render={renders.get(row.id) ?? null}
            selected={selectedId === row.id}
            checked={selectedIds.has(row.id)}
            drag={drag.dragProps(row)}
            dropTarget={drag.dropTarget === row.id}
            onOpenFolder={openFolder}
            onSelect={select}
            onToggle={toggleSelected}
            onPreview={onPreview}
            actions={actions}
            tagging={tagging}
            companions={companionCounts?.get(row.id) ?? 0}
            companionsOpen={openedCompanions?.has(row.id) ?? false}
            onToggleCompanions={onToggleCompanions}
            nested={Boolean(companionOf(row))}
          />
        ))}
      </ul>
      <MorePages
        hasMore={page.hasMore}
        loading={page.loading}
        onLoadMore={() => void page.loadMore()}
      />
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
  actions,
  tagging,
  drag,
  dropTarget,
  companions = 0,
  companionsOpen = false,
  onToggleCompanions,
  nested = false
}: {
  row: TeamMaterialRow;
  drag: ReturnType<ReturnType<typeof useMaterialDrag>['dragProps']>;
  dropTarget: boolean;
  session: ThumbnailSession | null;
  client: ContentGridClient;
  render: RenderArtifactRef | null;
  selected: boolean;
  checked: boolean;
  onOpenFolder: (folderId: string) => void;
  onSelect: (materialId: string | null) => void;
  onToggle: (row: TeamMaterialRow) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
  tagging?: TaggingProps;
  /** Its own companions, folded away (024, US25), and whether this tile is one of them. */
  companions?: number;
  companionsOpen?: boolean;
  onToggleCompanions?: (rowId: string) => void;
  nested?: boolean;
}) {
  const { t, language } = useI18n();
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
      }${dropTarget ? ' is-drop-target' : ''}${nested ? ' is-nested' : ''}`}
      data-material-id={row.id}
      aria-selected={selected}
      {...drag}
      onClick={() => onSelect(row.id)}
      onDoubleClick={open}
    >
      <button
        type="button"
        className="team-explorer-tile-visual"
        aria-label={t('teamExplorerOpenNamed', { name: row.name })}
        /*
         * One press chooses, two open — a folder as much as a file (the owner,
         * 024: "the same for every file"). A folder that opened on the first
         * press could not be selected to act on at all, and the list and the
         * grid disagreed about which gesture meant what.
         */
        onClick={event => {
          event.stopPropagation();
          onSelect(row.id);
        }}
        onDoubleClick={event => {
          event.stopPropagation();
          open();
        }}
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
        className="team-explorer-check team-explorer-tile-check"
        onClick={event => event.stopPropagation()}
        title={t('teamExplorerSelectNamed', { name: row.name })}
      >
        <input
          type="checkbox"
          aria-label={t('teamExplorerSelectNamed', { name: row.name })}
          checked={checked}
          onChange={() => onToggle(row)}
        />
        <span aria-hidden="true" />
      </label>
      {actions && (
        <div className="team-explorer-tile-actions" onClick={event => event.stopPropagation()}>
          <RowActions {...actions} row={row} />
        </div>
      )}
      <div className="team-explorer-tile-caption">
        <span className="team-explorer-tile-name" title={row.name}>
          {row.name}
        </span>
        {/* One quiet line under the name, as Drive and Frame.io draw it (024):
            the picture already says "image" or "video", so the kind is named
            only where there is no picture; then size and date. The colour tag
            shows when there is one — setting it is in the menu. */}
        <span className="team-explorer-tile-meta">
          {/* A tile with no mark had no dot at all, so the only way to put one on was the row
              menu — while the tile beside it, already marked, offered the colours on a press.
              The empty ring is drawn for whoever may tag and shows itself on hover, as the
              list's does. */}
          {(row.tagColor || tagging) && row.kind !== 'folder' && (
            <TagDot
              color={row.tagColor ?? null}
              name={row.name}
              canTag={Boolean(tagging)}
              onChange={color => tagging?.onSetTag(row, color)}
            />
          )}
          <span className="team-explorer-tile-facts">
            {[
              image || row.kind === 'folder' ? null : t(KIND_LABEL[row.kind]),
              row.kind === 'folder' ? null : displayedSize(row.sizeBytes, row.mimeType),
              row.modifiedAt ? formatDate(row.modifiedAt, language) : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {companions > 0 && onToggleCompanions && (
          /* The video's own files — its text, its catalogs — on a press rather than spread
             through the folder (024, US25). */
          <button
            type="button"
            className="team-explorer-tile-companions"
            aria-expanded={companionsOpen}
            onClick={event => {
              event.stopPropagation();
              onToggleCompanions(row.id);
            }}
          >
            <Paperclip size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(companionsOpen ? 'teamExplorerCompanionsHide' : 'teamExplorerCompanions', {
              count: companions
            })}
          </button>
        )}
        {row.kind === 'landing' && row.landingRender && (
          <span className={`team-explorer-tile-render is-${row.landingRender.state}`}>
            {t(RENDER_LABEL[row.landingRender.state])}
          </span>
        )}
        {reason && <KindNote text={t(reason)} />}
      </div>
    </li>
  );
}
