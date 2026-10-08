import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { TeamTaskAttachmentSummary, ThumbnailSession } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { KindIcon } from '../explorer/KindIcon';
import { useThumbnailSession } from '../explorer/useThumbnailSession';
import { onTaskAttachmentsChanged } from './taskAttachmentEvents';
import { HoverPeek } from '../workspace/HoverPeek';

const PEEK_LIMIT = 12;

/**
 * A task's attachments, on its paperclip count (the owner, 024).
 *
 * "📎 2" said how many and not what; finding out meant opening the task. Resting on the count
 * shows the files as small tiles — a picture where there is one, the kind's icon where there is
 * not — with each name under it.
 */
export function TaskAttachmentsPeek({
  teamId,
  taskId,
  count,
  trigger
}: {
  teamId: string;
  taskId: string;
  count: number;
  trigger: ReactNode;
}) {
  const { t } = useI18n();
  const [requested, setRequested] = useState(false);
  const [revision, setRevision] = useState(0);
  const [attachments, setAttachments] = useState<TeamTaskAttachmentSummary[] | null>(null);
  const session = useThumbnailSession({ teamId, client: teamApi, enabled: requested });

  // This state belongs to the card, so closing the popover does not discard it.
  useEffect(
    () => onTaskAttachmentsChanged(taskId, () => setRevision(value => value + 1)),
    [taskId]
  );
  useEffect(() => {
    if (!requested) return;
    let active = true;
    setAttachments(null);
    void teamApi
      .getTask({ teamId, taskId, attachmentPageSize: PEEK_LIMIT })
      .then(found => {
        if (active) setAttachments(found.attachments);
      })
      .catch(() => {
        if (active) {
          setAttachments([]);
          setRequested(false);
        }
      });
    return () => {
      active = false;
    };
  }, [taskId, teamId, count, requested, revision]);

  // Share the explorer's stable, browser-cacheable thumbnails and warm them
  // while the hover delay is running. No media grants or full-size downloads.
  useEffect(() => {
    if (!session || !attachments) return;
    const images = attachments.filter(hasPicture).map(attachment => {
      const image = new Image();
      image.src = teamApi.thumbnailUrl(session, attachment.materialId);
      return image;
    });
    return () => {
      for (const image of images) image.onload = image.onerror = null;
    };
  }, [attachments, session]);

  return (
    <HoverPeek
      trigger={trigger}
      label={t('teamTaskAttachmentsCount', { count })}
      className="team-task-attachments-peek"
      onIntent={() => setRequested(true)}
    >
      {() => <AttachmentTiles attachments={attachments} session={session} />}
    </HoverPeek>
  );
}

function AttachmentTiles({
  attachments,
  session
}: {
  attachments: TeamTaskAttachmentSummary[] | null;
  session: ThumbnailSession | null;
}) {
  const { t } = useI18n();
  if (attachments === null) {
    return <p className="team-peek-empty is-loading">{t('teamPreviewLoading')}</p>;
  }
  if (attachments.length === 0) {
    return <p className="team-peek-empty">{t('teamTaskAttachmentsEmpty')}</p>;
  }
  return (
    <ul
      className="team-peek-grid"
      style={{ '--peek-columns': Math.min(3, attachments.length) } as CSSProperties}
    >
      {attachments.map(attachment => (
        <li key={attachment.id} className="team-peek-tile" title={attachment.name}>
          <AttachmentThumb session={session} attachment={attachment} />
          <span className="team-peek-tile-open">
            <span className="team-peek-tile-title">{attachment.name}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function hasPicture(attachment: TeamTaskAttachmentSummary): boolean {
  return (
    (attachment.category === 'image' || attachment.category === 'video') &&
    attachment.availability === 'ready' &&
    attachment.previewState !== 'unavailable'
  );
}

function AttachmentThumb({
  session,
  attachment
}: {
  session: ThumbnailSession | null;
  attachment: TeamTaskAttachmentSummary;
}) {
  const src =
    session && hasPicture(attachment) ? teamApi.thumbnailUrl(session, attachment.materialId) : null;
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  return (
    <span className="team-peek-tile-thumb" aria-hidden="true">
      {src && src !== brokenSrc ? (
        <img src={src} alt="" loading="eager" decoding="sync" onError={() => setBrokenSrc(src)} />
      ) : (
        <KindIcon kind={attachment.category ?? 'other'} />
      )}
    </span>
  );
}
