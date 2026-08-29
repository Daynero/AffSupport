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
import { CATEGORY_LABEL } from '../explorer/rowKinds';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { thumbnailRelayUrl } from '../library/thumbnailRelay';
import { cachedPreview } from '../preview-url-cache';

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

type AttachmentAction = 'view' | 'download' | 'copy-link' | 'detach';

function AttachmentActionIcon({ action }: { action: AttachmentAction }) {
  if (action === 'view') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M2.2 10s2.65-4.55 7.8-4.55S17.8 10 17.8 10s-2.65 4.55-7.8 4.55S2.2 10 2.2 10Z" />
        <circle cx="10" cy="10" r="2.15" />
      </svg>
    );
  }
  if (action === 'download') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M10 2.8v9.2m0 0 3.2-3.2M10 12 6.8 8.8M3.4 14.7v1.15c0 .75.6 1.35 1.35 1.35h10.5c.75 0 1.35-.6 1.35-1.35V14.7" />
      </svg>
    );
  }
  if (action === 'copy-link') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="m7.65 12.35 4.7-4.7M7.3 15.55l-1.1 1.1a3 3 0 0 1-4.25-4.25l3.05-3.05A3 3 0 0 1 9.25 9m3.45 2a3 3 0 0 1 .75-3.2l1.1-1.1a3 3 0 1 1 4.25 4.25L15.75 14a3 3 0 0 1-4.25 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m7.55 12.45 4.9-4.9M7.15 15.65 5.5 17.3a2.7 2.7 0 0 1-3.8-3.8l3-3M12.85 4.35 14.5 2.7a2.7 2.7 0 0 1 3.8 3.8l-3 3M3 3l14 14" />
    </svg>
  );
}

export function TaskAttachmentTile({
  teamId,
  attachment,
  client = defaultClient,
  onDetach,
  isDraft = false
}: {
  teamId: string;
  attachment: TeamTaskAttachmentSummary;
  client?: TaskAttachmentPreviewClient;
  onDetach?: () => void;
  /** New attachments remain local until the task itself is saved. */
  isDraft?: boolean;
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
      void cachedPreview(
        (id, materialId, mode) => client.previewMaterial(id, materialId, mode),
        teamId,
        attachment.materialId,
        'media'
      )
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
  }, [
    attachment.availability,
    attachment.category,
    attachment.materialId,
    attachment.previewState,
    client,
    teamId
  ]);

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
    <article
      className={`team-task-attachment ${isDraft ? 'is-draft' : ''}`.trim()}
      data-availability={attachment.availability}
    >
      <div className="team-task-attachment-preview">
        {thumbnailUrl && (
          <img
            loading="lazy"
            decoding="async"
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
            loading="lazy"
            decoding="async"
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
            <small>{t(CATEGORY_LABEL[attachment.category ?? 'other'])}</small>
            {isDraft && (
              <small className="team-task-attachment-draft">{t('teamTaskAttachmentDraft')}</small>
            )}
          </div>
        </div>
        {/* Icon-only controls with the label as the accessible name and the
            tooltip. Four labelled buttons did not fit a 158px tile: every one
            of them broke its word across two lines ("Копіюв / ати посила /
            ння"), which is the opposite of the quick glance a reference tile
            is for. */}
        <div className="team-task-attachment-actions">
          <Button
            type="button"
            variant="ghost"
            className="team-task-attachment-action is-view"
            disabled={!rangeUrl || unavailable}
            title={t('teamTaskAttachmentView')}
            aria-label={t('teamTaskAttachmentView')}
            onClick={() => setPreviewOpen(true)}
          >
            <AttachmentActionIcon action="view" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="team-task-attachment-action is-download"
            loading={action === 'download'}
            title={t('teamTaskAttachmentDownload')}
            aria-label={t('teamTaskAttachmentDownload')}
            onClick={() => void download()}
          >
            <AttachmentActionIcon action="download" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`team-task-attachment-action is-copy-link${copied ? ' is-copied' : ''}`}
            loading={action === 'copy-link'}
            title={copied ? t('teamTaskAttachmentLinkCopied') : t('teamTaskAttachmentCopyLink')}
            aria-label={
              copied ? t('teamTaskAttachmentLinkCopied') : t('teamTaskAttachmentCopyLink')
            }
            onClick={() => void copyLink()}
          >
            <AttachmentActionIcon action="copy-link" />
          </Button>
          {/* No dialog: detaching is reversible, and the Undo in the toast
              costs one press to fix a mistake that the dialog charged a press
              to prevent every single time (FR-028). */}
          {onDetach && (
            <Button
              type="button"
              variant="ghost"
              className="team-task-attachment-action is-detach"
              title={t('teamTaskDetach')}
              aria-label={t('teamTaskDetach')}
              onClick={() => onDetach()}
            >
              <AttachmentActionIcon action="detach" />
            </Button>
          )}
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
              <img
                loading="lazy"
                decoding="async"
                src={rangeUrl}
                alt={attachment.name}
                referrerPolicy="no-referrer"
              />
            )}
          </div>
        </Modal>
      )}
    </article>
  );
}
