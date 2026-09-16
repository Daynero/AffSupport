import { useEffect, useState } from 'react';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamMaterialRow,
  ThumbnailSession
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { ProgressBar } from '../../components/ui';
import { useI18n } from '../../i18n';
import { KIND_LABEL, KIND_REASON, PREVIEWABLE_KINDS, previewSummary } from './rowKinds';
import { KindIcon } from './KindIcon';
import { useExplorer } from './ExplorerProvider';
import { useThumbnailSession, type ThumbnailSessionClient } from './useThumbnailSession';
import { PaneActions } from './PaneActions';
import { VideoTextActions } from '../library/VideoTextActions';
import { useToasts } from '../../components/toast';
import { MaterialDetail } from '../materials/MaterialDetail';
import { useMaterialCompanions } from '../materials/useMaterialCompanions';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { EmptyState } from '../../components/ui/index';

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
  onTranscribe?: (row: TeamMaterialRow) => void;
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
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { teamId } = useExplorer();
  const session = useThumbnailSession({ teamId, client, enabled: row !== null });
  const [render, setRender] = useState<RenderArtifactRef | null>(null);
  const [broken, setBroken] = useState(false);

  // A new row (or a new version of the same one) deserves a fresh attempt.
  useEffect(() => setBroken(false), [row?.id, row?.driveVersion]);

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
  const companions = useMaterialCompanions(
    {
      id: row?.id ?? '',
      teamId,
      kind: row?.kind === 'folder' ? 'folder' : 'file',
      category: row?.category ?? null
    },
    { enabled: Boolean(row), revision }
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
    <aside className="team-explorer-pane" aria-label={t('teamExplorerPaneLabel')}>
      <MaterialDetail
        name={row.name}
        className="team-explorer-pane-detail"
        facts={{
          kindLabel: t(KIND_LABEL[row.kind]),
          sizeBytes: row.kind === 'folder' ? null : row.sizeBytes,
          modifiedAt: row.modifiedAt
        }}
        companions={companions}
        preview={
          image ? (
            <img src={image} alt="" decoding="async" onError={() => setBroken(true)} />
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
               offers it, with the original and the translation to choose
               from, and a second "make text" icon above it was the same
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
       * can do something the menu cannot: choose *which* text — the original
       * or a translation — and read it. A menu item that copies "the text"
       * is right on a task tile and in a search result, where there is one
       * press and no room for a question; here there is room for the
       * question, so the pane asks it and does not also offer the shortcut.
       * `copyText` is left unwired in `PaneActions` for exactly that reason.
       */}
      {row.category === 'video' && onTranscribe && (
        <div className="team-explorer-pane-transcript">
          <p className="team-explorer-pane-transcript-title">{t('teamTranscriptSection')}</p>
          {transcribing && transcribing.videoId === row.id ? (
            <div className="team-explorer-pane-transcribing" aria-live="polite">
              <div className="team-explorer-pane-transcribing-head">
                <span>{t('teamTranscriptInProgress')}</span>
                <span>{Math.round(transcribing.progress)}%</span>
              </div>
              <ProgressBar
                value={transcribing.progress}
                active
                label={t('teamTranscriptInProgress')}
              />
            </div>
          ) : (
            <VideoTextActions
              teamId={teamId}
              videoId={row.id}
              onTranscribe={() => onTranscribe(row)}
              onRetranscribe={() => onTranscribe(row)}
              onCopied={() => push({ tone: 'success', text: t('teamTranscriptCopied') })}
            />
          )}
        </div>
      )}
    </aside>
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
