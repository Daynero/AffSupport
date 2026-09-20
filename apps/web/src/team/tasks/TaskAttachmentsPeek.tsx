import { useEffect, useState, type ReactNode } from 'react';
import type { TeamTaskAttachmentSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { KindIcon } from '../explorer/KindIcon';
import { thumbnailRelayUrl } from '../library/thumbnailRelay';
import { cachedPreview } from '../preview-url-cache';
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
  return (
    <HoverPeek trigger={trigger} label={t('teamTaskAttachmentsCount', { count })}>
      {() => <AttachmentTiles teamId={teamId} taskId={taskId} />}
    </HoverPeek>
  );
}

function AttachmentTiles({ teamId, taskId }: { teamId: string; taskId: string }) {
  const { t } = useI18n();
  const [attachments, setAttachments] = useState<TeamTaskAttachmentSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    void teamApi
      .getTask({ teamId, taskId, attachmentPageSize: PEEK_LIMIT })
      .then(found => {
        if (active) setAttachments(found.attachments);
      })
      .catch(() => {
        if (active) setAttachments([]);
      });
    return () => {
      active = false;
    };
  }, [taskId, teamId]);

  if (attachments === null) {
    return <p className="team-peek-empty is-loading">{t('teamPreviewLoading')}</p>;
  }
  if (attachments.length === 0) {
    return <p className="team-peek-empty">{t('teamTaskAttachmentsEmpty')}</p>;
  }
  return (
    <ul className="team-peek-grid">
      {attachments.map(attachment => (
        <li key={attachment.id} className="team-peek-tile" title={attachment.name}>
          <AttachmentThumb teamId={teamId} attachment={attachment} />
          <span className="team-peek-tile-open">
            <span className="team-peek-tile-title">{attachment.name}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function AttachmentThumb({
  teamId,
  attachment
}: {
  teamId: string;
  attachment: TeamTaskAttachmentSummary;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const pictured =
    (attachment.category === 'image' || attachment.category === 'video') &&
    attachment.availability === 'ready' &&
    attachment.previewState !== 'unavailable';

  useEffect(() => {
    if (!pictured) return;
    let active = true;
    void cachedPreview(
      (id, materialId, mode) => teamApi.previewMaterial(id, materialId, mode),
      teamId,
      attachment.materialId,
      'media'
    )
      .then(result => {
        if (active && result.kind === 'media') setSrc(thumbnailRelayUrl(result.rangeUrl));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [attachment.materialId, pictured, teamId]);

  return (
    <span className="team-peek-tile-thumb" aria-hidden="true">
      {src && !broken ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      ) : (
        <KindIcon kind={attachment.category ?? 'other'} />
      )}
    </span>
  );
}
