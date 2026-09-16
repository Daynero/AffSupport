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
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { MaterialInlineActions } from '../materials/MaterialInlineActions';
import { useMaterialActionList } from '../materials/useMaterialActionList';
import { spaceOf, type ActionContext, type MaterialRef } from '../materials/actions';
import { useMaterialCompanions } from '../materials/useMaterialCompanions';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { useI18n, type TranslationKey } from '../../i18n';
import { thumbnailRelayUrl } from '../library/thumbnailRelay';
import { cachedPreview } from '../preview-url-cache';
import { MaterialPreview } from '../preview/MaterialPreview';
import { KindIcon } from '../explorer/KindIcon';
import type { TeamMaterialRowKind } from '@video-compressor/shared';

/** Kinds that have a picture to wait for; the rest are drawn as their glyph. */
const HAS_PICTURE = new Set(['video', 'image', 'landing']);

function kindOfCategory(category: TeamTaskAttachmentSummary['category']): TeamMaterialRowKind {
  switch (category) {
    case 'transcript':
      return 'transcript';
    case 'archive':
      return 'archive';
    default:
      return 'other';
  }
}
import { useMaterialActionHost } from '../materials/MaterialActionHost';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';

/* A member the space has not told us about may read and nothing more. */
const NO_PERMISSIONS = DEFAULT_ROLE_PERMISSIONS.viewer;
const NO_BROWSING: FolderPickerClient = { listMaterials: async () => [] };

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

/** Why an attachment cannot be used, said rather than only styled. */
const AVAILABILITY_COPY: Record<
  Exclude<TeamTaskAttachmentSummary['availability'], 'ready'>,
  TranslationKey
> = {
  trashed: 'teamTaskAttachmentTrashed',
  missing: 'teamTaskAttachmentMissing',
  unavailable: 'teamTaskAttachmentUnavailable'
};

export function TaskAttachmentTile({
  teamId,
  attachment,
  client = defaultClient,
  onDetach,
  onReveal,
  onDownloadRestitched,
  onProductCatalog,
  onTranscribe,
  onCompress,
  onProcess,
  browseClient,
  companionsRevision = 0,
  restitching = false,
  isDraft = false
}: {
  teamId: string;
  attachment: TeamTaskAttachmentSummary;
  client?: TaskAttachmentPreviewClient;
  onDetach?: () => void;
  /** Open the explorer where the attached file lives, with it selected. */
  onReveal?: () => void;
  /**
   * Download the video re-stitched, when this member may. Offered by the
   * editor, which owns the one delivery this page can run at a time; the tile
   * only asks for it.
   */
  onDownloadRestitched?: () => void;
  /**
   * Make or open this video's product catalog, without leaving the task.
   *
   * This is the whole reason the action surface exists. Doing it used to mean
   * closing the task, finding the file in the explorer, doing it there, and
   * coming back — and the task's unsaved edits did not survive the trip.
   */
  onProductCatalog?: () => void;
  /**
   * The rest of "Make", from the task (024, FR-076): a transcript, a
   * compressed copy, any other tool. The editor owns the dialogs and the queue
   * hand-off, and what comes out is put back on the task.
   */
  onTranscribe?: () => void;
  onCompress?: () => void;
  onProcess?: () => void;
  /**
   * For the shared operations — rename, move, copy the text, the local app's
   * download — which need to browse folders. Without it they are not offered.
   */
  browseClient?: FolderPickerClient;
  /** Bumped when something was made from this material, so its companions re-read. */
  companionsRevision?: number;
  /** That delivery is this attachment's, and still running. */
  restitching?: boolean;
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
  /**
   * Opened in the shared viewer rather than as a picture in this dialog: a
   * landing and an archive go through the paired app, a transcript is read
   * from the catalogue. None of the three has a range URL of its own, which is
   * what the view control used to require — so the eye was dead on every kind
   * that is not an image or a video.
   */
  const opensInViewer =
    attachment.category === 'landing' ||
    attachment.category === 'archive' ||
    attachment.category === 'transcript';
  const [action, setAction] = useState<'download' | 'copy-link' | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  const { teams, activeTeam } = useTeam();
  const space = spaceOf(teams, activeTeam, teamId);
  const agent = useOptionalAgent();

  /**
   * This attachment, described the way every other surface describes a file.
   *
   * The shape is deliberately the narrow one: a task knows an attachment's id,
   * name, category and availability, and nothing else — and that is enough to
   * offer the same actions the explorer offers, which is the point.
   */
  // The owner's example, finished: a video attached to a task that already has
  // a catalog says so and opens it, instead of silently offering to make a
  // second one beside the first.
  const companions = useMaterialCompanions(
    {
      id: attachment.materialId,
      teamId,
      kind: attachment.kind === 'folder' ? 'folder' : 'file',
      category: attachment.category,
      draft: isDraft
    },
    { revision: companionsRevision }
  );

  const material: MaterialRef = {
    id: attachment.materialId,
    teamId,
    name: attachment.name,
    kind: attachment.kind === 'folder' ? 'folder' : 'file',
    category: attachment.category,
    // An attachment does not carry its size, so a download from a task tries
    // the browser first and falls back to the agent on the cutoff — the same
    // result, one round trip later. Its bucket reports as unknown until the
    // attachment summary carries a size.
    fileExtension: attachment.name.includes('.')
      ? (attachment.name.split('.').pop() ?? null)
      : null,
    availability: attachment.availability,
    trashed: attachment.availability === 'trashed',
    draft: isDraft,
    companions
  };

  const context: ActionContext = {
    host: 'task-attachment',
    permissions: space?.permissions ?? null,
    isOwner: space?.role === 'owner',
    agentConnected: agent?.teamWorkspaceAvailable === true,
    storageConnected: space?.connectionState === 'connected',
    restitchConfigured: true,
    // The catalog dialog already explains a missing default and links to the
    // panel that fixes it, so the reason is told once, where it can be acted
    // on, rather than twice.
    catalogSettingsReady: true
  };

  const isFolder = attachment.kind === 'folder';

  /* The same operations a folder row runs — rename, move, the transcript's text,
     the local app's download — with the dialogs they open, owned here. */
  const host = useMaterialActionHost({
    teamId,
    material,
    permissions: space?.permissions ?? NO_PERMISSIONS,
    browseClient: browseClient ?? NO_BROWSING,
    onChanged: () => undefined
  });

  const actions = useMaterialActionList(
    material,
    context,
    {
      ...(browseClient
        ? {
            copyText: host.handlers.copyText,
            rename: host.handlers.rename,
            move: host.handlers.move
          }
        : {}),
      // Opening a folder means going into it, not previewing it. It used to
      // raise the preview dialog, which had nothing to show and said so in a
      // generic sentence about an attachment that could not be loaded (024,
      // FR-070).
      open: isFolder ? onReveal : () => setPreviewOpen(true),
      showInFolder: onReveal,
      copyLink: () => void copyLink(),
      download: () => void download(),
      downloadRestitched: onDownloadRestitched,
      productCatalog: onProductCatalog,
      transcribe: onTranscribe,
      compress: onCompress,
      process: onProcess,
      // The viewer is where a transcript is read, and it carries the editor.
      editText: attachment.category === 'transcript' ? () => setPreviewOpen(true) : undefined,
      detach: onDetach
    },
    { maxInline: 2 }
  );

  useEffect(() => {
    let active = true;
    setRangeUrl(null);
    setThumbnailUrl(null);
    setVideoReady(false);
    // No preview will ever come for these (a folder, an unpreviewable file):
    // say so instead of "preparing…" forever.
    const noPreview =
      attachment.availability !== 'ready' || attachment.previewState === 'unavailable';
    setUnavailable(noPreview);
    if (noPreview) {
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
      if (grant.kind !== 'browser') {
        // Too large for the browser (FR-082): the local app takes it, the same
        // way a folder row's download does, instead of a sentence about failure.
        if (browseClient && host.handlers.download) {
          host.handlers.download();
          return;
        }
        throw new Error('AGENT_REQUIRED');
      }
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
            {/* A file with no picture of itself — a transcript, a document, a
                folder — shows what it is, not an apology (024, US14). The
                sentence is kept for a picture that should have come and did
                not. */}
            {unavailable &&
            attachment.availability === 'ready' &&
            !HAS_PICTURE.has(attachment.category ?? '') ? (
              <KindIcon
                kind={attachment.kind === 'folder' ? 'folder' : kindOfCategory(attachment.category)}
              />
            ) : unavailable ? (
              t('teamTaskPreviewUnavailable')
            ) : (
              t('teamTaskPreviewLoading')
            )}
          </span>
        )}
      </div>
      <div className="team-task-attachment-caption">
        <div className="team-task-attachment-caption-heading">
          <div>
            <strong title={attachment.name}>{attachment.name}</strong>
            <small>
              {attachment.kind === 'folder'
                ? t('teamTaskAttachmentFolder')
                : t(CATEGORY_LABEL[attachment.category ?? 'other'])}
            </small>
            {isDraft && (
              <small className="team-task-attachment-draft">
                {t('teamTaskAttachmentAttaching')}
              </small>
            )}
            {/* Why this tile is not like the others, in words. It used to say
                it only in `data-availability` and a dimmed preview, so a file
                somebody had trashed looked the same as one whose thumbnail was
                slow, and the actions under it failed into a generic message
                (024, FR-069). */}
            {!isDraft && attachment.availability !== 'ready' && (
              <small className="team-task-attachment-state">
                {t(AVAILABILITY_COPY[attachment.availability])}
              </small>
            )}
          </div>
        </div>
        <MaterialInlineActions
          list={actions}
          name={attachment.name}
          busy={
            action === 'download'
              ? 'download'
              : action === 'copy-link'
                ? 'copyLink'
                : restitching
                  ? 'downloadRestitched'
                  : null
          }
          done={copied ? 'copyLink' : null}
          size="sm"
          worded={{
            productCatalog:
              (companions?.productCatalog?.count ?? 0) > 1
                ? t('materialActionProductCatalogs', {
                    count: companions?.productCatalog?.count ?? 0
                  })
                : t('productCatalogMenuEntry')
          }}
          className="team-task-attachment-actions"
        />
        {actionFailed && (
          <small className="team-task-attachment-action-error">
            {t('teamTaskAttachmentActionFailed')}
          </small>
        )}
      </div>
      {host.dialogs}
      {previewOpen && opensInViewer && (
        <MaterialPreview
          teamId={teamId}
          material={{
            id: attachment.materialId,
            name: attachment.name,
            category: attachment.category,
            fileExtension: attachment.name.includes('.')
              ? (attachment.name.split('.').pop() ?? null)
              : null
          }}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {previewOpen && !opensInViewer && rangeUrl && (
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
