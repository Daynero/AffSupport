import { useEffect, useState } from 'react';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamMaterialRow,
  ThumbnailSession
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Download, Trash2 } from 'lucide-react';
import { Button, ProgressBar } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { formatSize } from '../../format';
import { KIND_LABEL, KIND_REASON, PREVIEWABLE_KINDS, previewSummary } from './rowKinds';
import { KindIcon } from './KindIcon';
import { useExplorer } from './ExplorerProvider';
import { useThumbnailSession, type ThumbnailSessionClient } from './useThumbnailSession';
import { VideoTextActions } from '../library/VideoTextActions';

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
  onDelete
}: {
  /** The selected row, or null when nothing is selected. */
  row: TeamMaterialRow | null;
  client: PreviewPaneClient;
  onOpen?: (material: TeamMaterialSummary) => void;
  /** Start (re-)transcribing a video from its card. */
  onTranscribe?: (row: TeamMaterialRow) => void;
  /** The video currently being transcribed and how far along, if any. */
  transcribing?: { videoId: string; progress: number } | null;
  /** Create a task from this material (shown on a file's card). */
  onCreateTask?: (asset: { id: string; name: string }) => void;
  /** Save the original to this computer; absent when the member may not download. */
  onDownload?: (row: TeamMaterialRow) => void;
  /** Move it to the space's bin; absent when the member may not delete. */
  onDelete?: (row: TeamMaterialRow) => void;
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
  if (!row) {
    return (
      <aside className="team-explorer-pane is-empty" aria-label={t('teamExplorerPaneLabel')}>
        <p className="team-explorer-muted">{t('teamExplorerPreviewEmpty')}</p>
      </aside>
    );
  }

  const image = broken ? null : visual(row, session, render, client);
  const reason = KIND_REASON[row.kind];

  return (
    <aside className="team-explorer-pane" aria-label={t('teamExplorerPaneLabel')}>
      <div className="team-explorer-pane-visual">
        {image ? (
          <img src={image} alt="" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span className="team-explorer-tile-icon" aria-hidden="true">
            <KindIcon kind={row.kind} />
          </span>
        )}
      </div>
      <h3 className="team-explorer-pane-name">{row.name}</h3>
      <dl className="team-explorer-pane-facts">
        <dt>{t('teamExplorerPaneKind')}</dt>
        <dd>{t(KIND_LABEL[row.kind])}</dd>
        {row.sizeBytes !== null && row.kind !== 'folder' && (
          <>
            <dt>{t('teamExplorerPaneSize')}</dt>
            <dd>{formatSize(row.sizeBytes)}</dd>
          </>
        )}
        {row.modifiedAt && (
          <>
            <dt>{t('teamExplorerPaneModified')}</dt>
            <dd>{new Date(row.modifiedAt).toLocaleString()}</dd>
          </>
        )}
      </dl>
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
      {/* The two things done to a file most often, as icons rather than a second column of
          sentences — the same treatment the compressor gives its own row actions. Named for
          screen readers and on hover, because an icon alone is a guess. */}
      {(onDownload || onDelete) && row.kind !== 'folder' && (
        <div className="team-explorer-pane-icons">
          {onDownload && (
            <button
              type="button"
              className="team-explorer-pane-icon"
              aria-label={t('teamFileDownload')}
              data-tip={t('teamFileDownload')}
              onClick={() => onDownload(row)}
            >
              <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="team-explorer-pane-icon is-destructive"
              aria-label={t('teamFileTrash')}
              data-tip={t('teamFileTrash')}
              onClick={() => onDelete(row)}
            >
              <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {onOpen && PREVIEWABLE_KINDS.has(row.kind) && (
        <Button type="button" variant="primary" onClick={() => onOpen(previewSummary(row))}>
          {t('teamExplorerPreviewOpen')}
        </Button>
      )}
      {onCreateTask && row.kind !== 'folder' && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onCreateTask({ id: row.id, name: row.name })}
        >
          {t('teamExplorerCreateTask')}
        </Button>
      )}
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
