import { useEffect, useRef, useState } from 'react';
import type {
  LandingRenderPointer,
  RenderArtifactRef,
  TeamPreviewResult,
  TeamTaskAttachmentSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [unavailable, setUnavailable] = useState(attachment.availability !== 'ready');

  useEffect(() => {
    let active = true;
    setPreviewUrl(null);
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
          if (result.kind === 'media') setPreviewUrl(result.rangeUrl);
          else setUnavailable(true);
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
          if (artifact) setPreviewUrl(client.landingRenderImageUrl(artifact, 0));
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
      setPreviewUrl(null);
      setUnavailable(true);
    }
  };

  const markUnavailable = () => {
    setPreviewUrl(null);
    setVideoReady(false);
    setUnavailable(true);
  };

  return (
    <article className="team-task-attachment" data-availability={attachment.availability}>
      <div className="team-task-attachment-preview">
        {attachment.category === 'video' && previewUrl && (
          <video
            ref={element => {
              video.current = element;
              element?.setAttribute('referrerpolicy', 'no-referrer');
            }}
            src={previewUrl}
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
        {attachment.category !== 'video' && previewUrl && (
          <img
            src={previewUrl}
            alt={attachment.name}
            referrerPolicy="no-referrer"
            onError={markUnavailable}
          />
        )}
        {(!previewUrl || (attachment.category === 'video' && !videoReady)) && (
          <span className="team-task-attachment-fallback">
            {unavailable ? t('teamTaskPreviewUnavailable') : t('teamTaskPreviewLoading')}
          </span>
        )}
      </div>
      <div className="team-task-attachment-caption">
        <strong title={attachment.name}>{attachment.name}</strong>
        {onDetach && (
          <Button type="button" variant="ghost" onClick={onDetach}>
            {t('teamTaskDetach')}
          </Button>
        )}
      </div>
    </article>
  );
}
