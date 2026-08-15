import { useEffect, useRef, useState } from 'react';
import type {
  LibraryShareCopyRequest,
  LibraryShareCopyResult,
  LandingRenderPointer,
  RenderArtifactRef,
  TeamDownloadGrantResult,
  TeamPreviewResult,
  TeamTaskAttachmentSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { thumbnailRelayUrl } from '../library/thumbnailRelay';

export function taskVideoPreviewTimeSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(1, durationSeconds);
}

export interface TaskAttachmentPreviewClient {
  previewMaterial(
    teamId: string,
    materialId: string,
    mode: 'media' | 'transcript' | 'archive' | 'landing'
  ): Promise<TeamPreviewResult>;
  listLandingRenders(
    teamId: string,
    materialIds: string[],
    preset: string
  ): Promise<LandingRenderPointer[]>;
  landingRenderImageUrl(artifact: RenderArtifactRef, segment?: number): string;
  requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser'
  ): Promise<TeamDownloadGrantResult>;
  shareLibraryMaterial(request: LibraryShareCopyRequest): Promise<LibraryShareCopyResult>;
}

const defaultClient: TaskAttachmentPreviewClient = teamApi;

export function TaskAttachmentTile({
  teamId,
  attachment,
  client = defaultClient,
  onDetach
}: {
  teamId: string;
  attachment: TeamTaskAttachmentSummary;
  client?: TaskAttachmentPreviewClient;
  onDetach?: () => void;
}) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement | null>(null);
  const [rangeUrl, setRangeUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [unavailable, setUnavailable] = useState(attachment.availability !== 'ready');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [action, setAction] = useState<'download' | 'copy-link' | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setRangeUrl(null);
    setThumbnailUrl(null);
    setVideoReady(false);
    setUnavailable(attachment.availability !== 'ready');
    if (attachment.availability !== 'ready' || attachment.previewState === 'unavailable') {
      return;
    }
    if (attachment.category === 'image' || attachment.category === 'video') {
      void client
        .previewMaterial(teamId, attachment.materialId, 'media')
        .then(result => {
          if (!active) return;
          if (result.kind !== 'media') {
            setUnavailable(true);
            return;
          }
          setRangeUrl(result.rangeUrl);
          setThumbnailUrl(thumbnailRelayUrl(result.rangeUrl));
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
    } else if (attachment.category === 'landing') {
      void client
        .listLandingRenders(teamId, [attachment.materialId], 'default')
        .then(results => {
          if (!active) return;
          const artifact = results[0]?.artifact;
          if (artifact) setRangeUrl(client.landingRenderImageUrl(artifact, 0));
          else setUnavailable(true);
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
    } else {
      setUnavailable(true);
    }
    return () => {
      active = false;
    };
  }, [attachment, client, teamId]);

  const seekVideo = () => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return;
    const previewTime = taskVideoPreviewTimeSeconds(element.duration);
    if (previewTime === 0) {
      setVideoReady(true);
      return;
    }
    try {
      element.currentTime = previewTime;
    } catch {
      setRangeUrl(null);
      setUnavailable(true);
    }
  };

  const markUnavailable = () => {
    setRangeUrl(null);
    setThumbnailUrl(null);
    setVideoReady(false);
    setUnavailable(true);
  };

  const fallBackToRangePreview = () => {
    setThumbnailUrl(null);
  };

  const download = async () => {
    setAction('download');
    setActionFailed(false);
    try {
      const grant = await client.requestDownload(teamId, attachment.materialId, 'browser');
      if (grant.kind !== 'browser') throw new Error('AGENT_REQUIRED');
      const anchor = document.createElement('a');
      anchor.href = grant.rangeUrl;
      anchor.download = attachment.name;
      anchor.rel = 'noreferrer';
      anchor.click();
    } catch {
      setActionFailed(true);
    } finally {
      setAction(null);
    }
  };

  const copyLink = async () => {
    setAction('copy-link');
    setActionFailed(false);
    try {
      const result = await client.shareLibraryMaterial({
        teamId,
        materialId: attachment.materialId,
        // This action deliberately provisions an "anyone with the link" reader
        // permission when needed, then returns Drive's canonical webViewLink.
        allowIfRestricted: true,
        rememberChoice: false,
        idempotencyKey: `task.attachment.share.${crypto.randomUUID()}`
      });
      if (result.state !== 'ready') throw new Error('SHARE_NOT_READY');
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setActionFailed(true);
    } finally {
      setAction(null);
    }
  };

  const viewerTitleId = `team-task-attachment-viewer-${attachment.id}`;

  return (
    <article className="team-task-attachment" data-availability={attachment.availability}>
      <div className="team-task-attachment-preview">
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt={attachment.name}
            referrerPolicy="no-referrer"
            onError={fallBackToRangePreview}
          />
        )}
        {attachment.category === 'video' && rangeUrl && !thumbnailUrl && (
          <video
            ref={element => {
              video.current = element;
              element?.setAttribute('referrerpolicy', 'no-referrer');
            }}
            src={rangeUrl}
            muted
            playsInline
            preload="metadata"
            aria-label={t('teamTaskVideoPreview', { name: attachment.name })}
            className={videoReady ? 'is-ready' : ''}
            onLoadedMetadata={seekVideo}
            onSeeked={() => setVideoReady(true)}
            onError={markUnavailable}
          />
        )}
        {attachment.category !== 'video' && rangeUrl && !thumbnailUrl && (
          <img
            src={rangeUrl}
            alt={attachment.name}
            referrerPolicy="no-referrer"
            onError={markUnavailable}
          />
        )}
        {(!rangeUrl || (!thumbnailUrl && attachment.category === 'video' && !videoReady)) && (
          <span className="team-task-attachment-fallback">
            {unavailable ? t('teamTaskPreviewUnavailable') : t('teamTaskPreviewLoading')}
          </span>
        )}
      </div>
      <div className="team-task-attachment-caption">
        <div className="team-task-attachment-caption-heading">
          <div>
            <strong title={attachment.name}>{attachment.name}</strong>
            <small>{attachment.category ?? t('teamTaskAttachMedia')}</small>
          </div>
          {onDetach && (
            <Button
              type="button"
              variant="ghost"
              className="team-task-attachment-detach"
              onClick={onDetach}
            >
              {t('teamTaskDetach')}
            </Button>
          )}
        </div>
        <div className="team-task-attachment-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={!rangeUrl || unavailable}
            onClick={() => setPreviewOpen(true)}
          >
            {t('teamTaskAttachmentView')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            loading={action === 'download'}
            onClick={() => void download()}
          >
            {t('teamTaskAttachmentDownload')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            loading={action === 'copy-link'}
            onClick={() => void copyLink()}
          >
            {copied ? t('teamTaskAttachmentLinkCopied') : t('teamTaskAttachmentCopyLink')}
          </Button>
        </div>
        {actionFailed && (
          <small className="team-task-attachment-action-error">
            {t('teamTaskAttachmentActionFailed')}
          </small>
        )}
      </div>
      {previewOpen && rangeUrl && (
        <Modal
          nested
          labelledBy={viewerTitleId}
          onClose={() => setPreviewOpen(false)}
          closeLabel={t('teamCancel')}
          size="lg"
        >
          <div className="team-task-attachment-viewer">
            <h2 id={viewerTitleId}>{attachment.name}</h2>
            {attachment.category === 'video' ? (
              <video
                controls
                preload="metadata"
                src={rangeUrl}
                ref={element => element?.setAttribute('referrerpolicy', 'no-referrer')}
              />
            ) : (
              <img src={rangeUrl} alt={attachment.name} referrerPolicy="no-referrer" />
            )}
          </div>
        </Modal>
      )}
    </article>
  );
}
