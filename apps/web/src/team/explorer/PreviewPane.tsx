import { AudioLines, Rocket, X } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, IconButton } from '../../components/ui/index';
import { buildTeamRoute } from '../routes';
import { navigateTo } from '../../lib/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { crossfadePart, leaveCopy } from '../../lib/auto-crossfade';
import { BeforeChange } from '../../lib/before-change';
import { knownBroken, markBroken } from './brokenPictures';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamMaterialRow,
  ThumbnailSession
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { KIND_LABEL, KIND_REASON, PREVIEWABLE_KINDS, previewSummary } from './rowKinds';
import { KindIcon } from './KindIcon';
import { useExplorer } from './ExplorerProvider';
import { useThumbnailSession, type ThumbnailSessionClient } from './useThumbnailSession';
import { PaneActions } from './PaneActions';
import { VideoTextActions } from '../library/VideoTextActions';
import { WorkStrip } from '../../translation/TranslationProgress';
import { useToasts } from '../../components/toast';
import { MaterialDetail } from '../materials/MaterialDetail';
import { useMaterialCompanions } from '../materials/useMaterialCompanions';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { EmptyState, FadeImage } from '../../components/ui/index';
import { MaterialNoteBlock } from '../materials/MaterialNote';
import { displayedSize } from '../../format';
import { MaterialCatalogFacts } from '../materials/MaterialCatalogFacts';
import { MaterialTasks } from '../materials/MaterialTasks';
import { useTeam } from '../TeamContext';
import { MaterialRank } from '../ranks/MaterialRank';
import { carriesRank } from '../ranks/creativeRanks';

/**
 * What the selected row looks like, before it is opened (011, FR-016): the
 * prepared thumbnail or poster at once, the landing screenshot when a render
 * exists, and the way into the full viewer. Nothing here waits on the provider.
 */
export interface PreviewPaneClient extends ThumbnailSessionClient {
  listLandingRenders?: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  landingRenderImageUrl?: (artifact: RenderArtifactRef, segment: number) => string;
}

/**
 * What the card waits for before it is shown in place of the one before it: its picture, and
 * the note — the two that arrive a moment after the name does.
 */
const CARD_NOT_READY =
  '.team-material-detail-visual [aria-busy="true"], .team-material-note-pending';

export function PreviewPane({
  row,
  client,
  onOpen,
  onTranscribe,
  transcribing,
  onCreateTask,
  onDownload,
  onDownloadRestitched,
  onDelete,
  browseClient,
  onChanged,
  onClose,
  revision = 0
}: {
  /** The selected row, or null when nothing is selected. */
  row: TeamMaterialRow | null;
  client: PreviewPaneClient;
  /** Reads the folder tree for the move picker the shared actions own. */
  browseClient: FolderPickerClient;
  /** Something changed on the server; the shell reloads its page. */
  onChanged: () => void;
  onOpen?: (material: TeamMaterialSummary) => void;
  /** Start (re-)transcribing a video from its card. */
  /** `fresh` is a re-transcribe (012, T007): never reuse an identical transcript. */
  onTranscribe?: (row: TeamMaterialRow, options?: { fresh?: boolean }) => void;
  /** The video currently being transcribed and how far along, if any. */
  transcribing?: { videoId: string; progress: number } | null;
  /** Create a task from this material (shown on a file's card). */
  onCreateTask?: (asset: { id: string; name: string }) => void;
  /** Save the original to this computer; absent when the member may not download. */
  onDownload?: (row: TeamMaterialRow) => void;
  /** Cut this video's stitching and save that instead; videos only. */
  onDownloadRestitched?: (row: TeamMaterialRow) => void;
  /** Whether this space has already looked inside the file, so the cut is seconds away. */
  restitchPrepared?: boolean;
  /** Share by link; absent when the member may not share. */
  onShare?: boolean;
  /** Move it to the space's bin; absent when the member may not delete. */
  onDelete?: (row: TeamMaterialRow) => void;
  /** The space's realtime revision; a video's catalog is read again when it moves (022). */
  revision?: number;
  /** Puts the card away — on a phone it is a sheet over the list, and needs a way down. */
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { teamId } = useExplorer();
  const { teams, ranksRevision = 0 } = useTeam();
  const isOwner = teams.find(team => team.id === teamId)?.role === 'owner';
  const canEditNote = teams.find(team => team.id === teamId)?.permissions.manage_metadata === true;
  const session = useThumbnailSession({ teamId, client, enabled: row !== null });
  const [render, setRender] = useState<RenderArtifactRef | null>(null);
  // A new row (or a new version of the same one) deserves a fresh attempt — unless the same
  // picture has just failed on its tile, which it would again.
  const pictureKey = row ? `${row.id}:${row.driveVersion}` : '';
  const [brokenKey, setBrokenKey] = useState<string | null>(null);
  const broken = brokenKey === pictureKey || knownBroken(pictureKey);
  /** The picture that has decoded: until then the card before this one is still the one shown. */
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  /**
   * Whether the card has already shown another file. The first picture fades in over its
   * holder; one that replaces another arrives under the crossfade of the whole card.
   */
  const [first] = useState(row?.id);
  const [replaced, setReplaced] = useState(false);
  if (row && !replaced && row.id !== first) setReplaced(true);

  useEffect(() => {
    setRender(null);
    if (!row || row.kind !== 'landing' || row.landingRender?.state !== 'ready') return;
    if (!client.listLandingRenders) return;
    let active = true;
    void client
      .listLandingRenders(teamId, [row.id], 'default')
      .then(pointers => {
        if (!active) return;
        const pointer = pointers.find(item => item.materialId === row.id);
        setRender(pointer?.state === 'ready' && pointer.artifact ? pointer.artifact : null);
      })
      .catch(() => {
        if (active) setRender(null);
      });
    return () => {
      active = false;
    };
  }, [client, row, teamId]);

  // A cached thumbnail can go away — an evicted entry, an expired session —
  // and the tile already degrades to its kind glyph when that happens. The
  // pane showed the browser's torn-page icon instead, which reads as a broken
  // file rather than a missing preview.
  // One file is in focus here, so what lives beside it is worth two requests.
  // Read once, in the pane, and handed to both the card and the actions.
  const [madeRevision, setMadeRevision] = useState(0);
  const companions = useMaterialCompanions(
    {
      id: row?.id ?? '',
      teamId,
      kind: row?.kind === 'folder' ? 'folder' : 'file',
      category: row?.category ?? null
    },
    { enabled: Boolean(row), revision: revision + madeRevision }
  );

  // The card sees itself out (058). When it is taken away — the selection dropped, another
  // folder, a search — a copy of it slides off the way it came. Done here, as the element
  // leaves, it covers every way of losing the selection.
  const card = useRef<HTMLElement | null>(null);
  const leaving = useCallback((node: HTMLElement | null) => {
    card.current = node;
    if (!node) return;
    return () => {
      card.current = null;
      leaveCopy(node, 'is-leaving');
    };
  }, []);
  // Another file in a card that is already open (058): the picture went blank and came back,
  // and the note's row dropped out and returned, so the card flinched on every press. Now the
  // card as it was stays up until the next one has its picture, and dissolves into it — one
  // change, of the whole card. A copy already up (arrow keys held down) is left to finish.
  const swap = useCallback(
    () => crossfadePart(card.current, { keep: true, waitFor: CARD_NOT_READY }),
    []
  );

  if (!row) {
    return (
      <aside className="team-explorer-pane is-empty" aria-label={t('teamExplorerPaneLabel')}>
        {/* Nothing is chosen, which is not a failure and has no action: the
            pattern's smallest size, with the sentence and nothing else. */}
        <EmptyState size="sm" title={t('teamExplorerPreviewEmpty')} />
      </aside>
    );
  }

  const image = broken ? null : visual(row, session, render, client);
  const reason = KIND_REASON[row.kind];

  return (
    <aside ref={leaving} className="team-explorer-pane" aria-label={t('teamExplorerPaneLabel')}>
      <BeforeChange of={row.id} run={swap} />
      {onClose && <PaneClose onClose={onClose} />}
      <MaterialDetail
        name={row.name}
        className="team-explorer-pane-detail"
        facts={{
          kindLabel: t(KIND_LABEL[row.kind]),
          sizeBytes:
            row.kind === 'folder' || displayedSize(row.sizeBytes, row.mimeType) === null
              ? null
              : row.sizeBytes,
          modifiedAt: row.modifiedAt
        }}
        companions={companions}
        rank={
          carriesRank(row) ? (
            <MaterialRank
              key={row.id}
              teamId={teamId}
              materialId={row.id}
              isOwner={isOwner}
              ranksRevision={ranksRevision}
            />
          ) : null
        }
        catalogFacts={
          row.kind === 'folder' ? null : (
            <MaterialCatalogFacts teamId={teamId} material={{ id: row.id, name: row.name }} />
          )
        }
        inTasks={
          row.kind === 'folder' ? null : (
            <>
              <MaterialTasks
                teamId={teamId}
                material={{ id: row.id, name: row.name }}
                revision={revision}
              />
              {(row.kind === 'video' || row.kind === 'image') &&
                teams.find(team => team.id === teamId)?.permissions.edit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="material-tasks-add"
                    onClick={() =>
                      navigateTo(
                        buildTeamRoute({
                          spaceId: teamId,
                          section: 'launches',
                          query: {
                            launchId: 'new',
                            launchTab: 'settings',
                            launchMaterialId: row.id
                          }
                        })
                      )
                    }
                  >
                    <Rocket size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    {t('materialActionLaunch')}
                  </Button>
                )}
            </>
          )
        }
        note={
          row.kind === 'folder' ? null : (
            <MaterialNoteBlock
              teamId={teamId}
              materialId={row.id}
              canEdit={canEditNote}
              revision={revision}
            />
          )
        }
        preview={
          image ? (
            <FadeImage
              src={image}
              alt=""
              decoding="async"
              immediate={replaced}
              aria-busy={loadedImage !== image || undefined}
              onLoad={() => setLoadedImage(image)}
              onError={() => {
                markBroken(pictureKey);
                setBrokenKey(pictureKey);
              }}
            />
          ) : (
            <span className="team-explorer-tile-icon" aria-hidden="true">
              <KindIcon kind={row.kind} />
            </span>
          )
        }
        notes={
          <>
            {reason && <p className="team-explorer-tile-reason">{t(reason)}</p>}
            {row.previewState === 'unavailable' && row.previewReason && (
              <p className="team-explorer-tile-reason">
                {t(`teamExplorerThumbnail_${row.previewReason}` as never)}
              </p>
            )}
            {row.kind === 'landing' && row.landingRender && row.landingRender.state !== 'ready' && (
              <p className="team-explorer-tile-reason">
                {t(
                  row.landingRender.state === 'rendering'
                    ? 'teamExplorerRenderRendering'
                    : row.landingRender.state === 'failed'
                      ? 'teamExplorerRenderFailed'
                      : 'teamExplorerRenderNone'
                )}
              </p>
            )}
          </>
        }
        actions={
          /* Every action this file can take, from the one registry: the same
             list, in the same order, as the row above and the task beside it. */
          <PaneActions
            row={row}
            teamId={teamId}
            browseClient={browseClient}
            onChanged={onChanged}
            companions={companions}
            onCompanionsChanged={() => setMadeRevision(value => value + 1)}
            onOpen={
              onOpen && PREVIEWABLE_KINDS.has(row.kind)
                ? () => onOpen(previewSummary(row))
                : undefined
            }
            onCreateTask={
              onCreateTask ? () => onCreateTask({ id: row.id, name: row.name }) : undefined
            }
            onDownload={onDownload ? () => onDownload(row) : undefined}
            onDownloadRestitched={
              onDownloadRestitched ? () => onDownloadRestitched(row) : undefined
            }
            onDelete={onDelete ? () => onDelete(row) : undefined}
            /* Not `transcribe` here (024, FR-093): the text section below
               offers the original text, and a second "make text" icon above it was the same
               press twice. */
          />
        }
      />
      {/*
       * The catalog block that used to stand here is gone (024): "Product
       * catalog" is in the action list, and the dialog it opens already
       * offers the one that exists as well as a new one, so the block was a
       * second vocabulary for something the registry names.
       *
       * The text block stays, and deliberately. It is the one surface that
       * displays the original transcript directly, with its view, copy and retry actions.
       * `copyText` stays unwired in `PaneActions` to avoid a duplicate shortcut.
       */}
      {row.category === 'video' && (
        <div className="team-explorer-pane-transcript">
          <p className="team-explorer-pane-transcript-title">{t('teamTranscriptSection')}</p>
          {transcribing && transcribing.videoId === row.id ? (
            <div className="team-explorer-pane-transcribing">
              <WorkStrip
                compact
                icon={<AudioLines size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                label={t('teamTranscriptInProgress')}
                percent={transcribing.progress}
              />
            </div>
          ) : (
            <VideoTextActions
              teamId={teamId}
              videoId={row.id}
              onTranscribe={onTranscribe ? () => onTranscribe(row) : undefined}
              onRetranscribe={onTranscribe ? () => onTranscribe(row, { fresh: true }) : undefined}
              videoName={row.name}
              onCopied={variant =>
                push({ tone: 'success', text: t('textTranslationCopied', { variant }) })
              }
              compact
            />
          )}
        </div>
      )}
    </aside>
  );
}

/** The sheet's way down on a phone (070); beside a list it is not drawn — the list is there. */
export function PaneClose({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <IconButton
      className="team-explorer-pane-close"
      size="sm"
      variant="ghost"
      label={t('teamClose')}
      title=""
      onClick={onClose}
    >
      <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </IconButton>
  );
}

function visual(
  row: TeamMaterialRow,
  session: ThumbnailSession | null,
  render: RenderArtifactRef | null,
  client: PreviewPaneClient
): string | null {
  if (session && row.thumbnailReady && (row.kind === 'image' || row.kind === 'video')) {
    return client.thumbnailUrl(session, row.id);
  }
  if (render && client.landingRenderImageUrl) return client.landingRenderImageUrl(render, 0);
  return null;
}
