import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CatalogMaterialItem,
  LandingViewerPreset,
  TeamAgentPreviewResult,
  TeamPreviewResult
} from '@video-compressor/shared';
import {
  closeTeamPreview,
  openTeamArchivePreview,
  openTeamLandingPreview,
  teamLandingScreenshotUrl
} from '../../api/client';
import { teamApi } from '../../api/team';
import { X } from 'lucide-react';
import { Button } from '../../components/ui/index';
import { IconButton } from '../../components/ui/index';
import { ReconnectAction } from '../../components/ReconnectAction';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { CATEGORY_LABEL } from '../explorer/rowKinds';
import { useI18n } from '../../i18n';
import { teamErrorMessage } from '../errors';
import { LandingPreviewFrame, type LandingPreviewView } from './LandingPreviewFrame';
import { PreviewUnavailable } from './PreviewUnavailable';
import { startPreviewAttempt } from './previewAnalytics';
import { previewPoster } from './previewPoster';
import { VideoStage } from './VideoStage';
import { Modal } from '../../components/Modal';

type AgentRequest = Extract<TeamPreviewResult, { kind: 'agent' }>;
type AgentUnavailable = Extract<TeamAgentPreviewResult, { kind: 'unavailable' }>;
type ArchiveView = Extract<TeamAgentPreviewResult, { kind: 'archive' }>;

/**
 * The preview transport only needs a stable material identity and enough type
 * information to choose a safe viewer. Keep this deliberately smaller than a
 * catalog result so the same verified viewer can be opened from the material
 * tree and the Creative Library as well.
 */
export interface PreviewableMaterial {
  id: string;
  name: string;
  category: CatalogMaterialItem['category'];
  fileExtension?: CatalogMaterialItem['fileExtension'];
}

export interface MaterialPreviewClient {
  requestPreview: (
    teamId: string,
    materialId: string,
    mode: 'media' | 'transcript' | 'archive' | 'landing',
    /** Present only on a repeat after the stream failed. */
    options?: { fresh: boolean }
  ) => Promise<TeamPreviewResult>;
  openAgentArchive: (request: AgentRequest) => Promise<ArchiveView | AgentUnavailable>;
  openAgentLanding: (request: AgentRequest) => Promise<LandingPreviewView | AgentUnavailable>;
  closeAgentPreview: (operationId: string) => Promise<unknown>;
  commitLandingValidation?: (input: {
    teamId: string;
    materialId: string;
    operationId: string;
    ticket: string;
    validation: NonNullable<LandingPreviewView['validation']>;
  }) => Promise<boolean>;
  downloadMaterial?: (teamId: string, materialId: string) => void;
  editText?: (teamId: string, materialId: string) => void;
  createVersion?: (teamId: string, materialId: string) => void;
}

const defaultClient: MaterialPreviewClient = {
  requestPreview: (teamId, materialId, mode, options) =>
    options
      ? teamApi.previewMaterial(teamId, materialId, mode, options)
      : teamApi.previewMaterial(teamId, materialId, mode),
  openAgentArchive: async request => {
    const result = await openTeamArchivePreview(request);
    if (result.kind === 'landing') throw new Error('INVALID_RESPONSE');
    return result;
  },
  openAgentLanding: async request => {
    const result = await openTeamLandingPreview(request);
    if (result.kind === 'archive') throw new Error('INVALID_RESPONSE');
    return result.kind === 'landing'
      ? {
          kind: 'landing',
          operationId: result.operationId,
          url: result.url,
          sandbox: result.sandbox,
          warning: result.warning,
          screenshotUrl: result.screenshotAvailable
            ? teamLandingScreenshotUrl(result.operationId)
            : null,
          validation: result.validation
        }
      : result;
  },
  closeAgentPreview: closeTeamPreview,
  commitLandingValidation: input => teamApi.commitLandingPreviewValidation(input)
};

type DisplayState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | TeamPreviewResult
  | ArchiveView
  | LandingPreviewView;

export function MaterialPreview({
  teamId,
  material,
  client = defaultClient,
  landingPreset,
  toolbar,
  onClose
}: {
  teamId: string;
  material: PreviewableMaterial;
  client?: MaterialPreviewClient;
  landingPreset?: LandingViewerPreset;
  toolbar?: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<DisplayState>({ kind: 'loading' });
  const [loadedMediaKey, setLoadedMediaKey] = useState<string | null>(null);
  const [failedMediaKey, setFailedMediaKey] = useState<string | null>(null);
  /* A fresh request for the same file: a new grant and a new stream. */
  const [attempt, setAttempt] = useState(0);
  const autoRetried = useRef(false);
  const mediaCategory =
    state.kind === 'media'
      ? state.mimeType.startsWith('image/')
        ? 'image'
        : state.mimeType.startsWith('video/')
          ? 'video'
          : material.category
      : material.category;
  const operationId = useRef<string | null>(null);
  const closed = useRef(new Set<string>());

  const closeOperation = useCallback(
    (id: string | null) => {
      if (!id || closed.current.has(id)) return Promise.resolve();
      closed.current.add(id);
      return Promise.resolve(client.closeAgentPreview(id)).then(
        () => undefined,
        () => undefined
      );
    },
    [client]
  );

  const materialId = material.id;
  const mode = previewMode(material);
  const materialRef = useRef(material);
  materialRef.current = material;
  /* A repeat after the stream failed asks for a fresh read (an R2 grant refused, T051). */
  const freshRead = attempt > 0;
  useEffect(() => {
    let active = true;
    operationId.current = null;
    closed.current.clear();
    setState({ kind: 'loading' });
    // 033 FR-009: one started and one completed per opening, on one opaque attempt id.
    const attempt = startPreviewAttempt(materialRef.current.category);
    void client
      .requestPreview(teamId, materialId, mode, ...(freshRead ? [{ fresh: true }] : []))
      .then(async result => {
        if (!active) return;
        if (result.kind !== 'agent') {
          attempt.finish(result.kind === 'unavailable' ? 'unsupported' : 'success');
          setState(result);
          return;
        }
        operationId.current = result.operationId;
        const local =
          result.previewKind === 'archive'
            ? await client.openAgentArchive(result)
            : await client.openAgentLanding(result);
        if (!active) {
          await closeOperation(result.operationId);
          return;
        }
        attempt.finish(local.kind === 'unavailable' ? 'unsupported' : 'success');
        if (
          result.previewKind === 'landing' &&
          local.kind === 'landing' &&
          local.validation &&
          client.commitLandingValidation
        ) {
          void client
            .commitLandingValidation({
              teamId,
              materialId: materialId,
              operationId: result.operationId,
              ticket: result.transferGrant.ticket,
              validation: local.validation
            })
            .catch(() => undefined);
        }
        setState(
          local.kind === 'unavailable'
            ? { kind: 'unavailable', reason: local.reason, allowedActions: [] }
            : local
        );
      })
      .catch(error => {
        if (!active) return;
        const code = errorCode(error);
        attempt.finish('failure', code);
        setState({ kind: 'error', code });
      });
    return () => {
      active = false;
      // Closed before the preview settled: the attempt ends here, not as a failure.
      attempt.finish('cancelled');
      void closeOperation(operationId.current);
    };
  }, [attempt, client, closeOperation, freshRead, materialId, mode, teamId]);

  const close = () => {
    void closeOperation(operationId.current).finally(onClose);
  };
  const download = () => client.downloadMaterial?.(teamId, material.id);
  const edit = () => client.editText?.(teamId, material.id);
  const createVersion = () => client.createVersion?.(teamId, material.id);
  const mediaKey = state.kind === 'media' ? `${material.id}:${state.rangeUrl}` : null;
  const mediaLoading =
    mediaKey !== null && mediaKey !== loadedMediaKey && mediaKey !== failedMediaKey;
  const mediaFailed = mediaKey !== null && mediaKey === failedMediaKey;
  const markMediaReady = () => {
    if (mediaKey) setLoadedMediaKey(mediaKey);
  };
  /* The byte stream can refuse for a moment (Drive throttling a busy space):
     ask once more on our own before saying the preview failed. */
  const markMediaFailed = () => {
    if (!mediaKey) return;
    if (!autoRetried.current) {
      autoRetried.current = true;
      setAttempt(value => value + 1);
      return;
    }
    setFailedMediaKey(mediaKey);
  };
  const retry = () => {
    setFailedMediaKey(null);
    setAttempt(value => value + 1);
  };
  /*
   * A video is shown in its frame from the moment the viewer opens (070, phase 9е): the frame
   * takes the thumbnail's shape and holds the wait, so nothing jumps when the stream arrives.
   * Whether it is a video is known from the file before the grant and from the grant after it —
   * a restored creative with no cached category becomes one only then.
   */
  const poster = useMemo(() => previewPoster(materialId), [materialId]);
  const showStage =
    (state.kind === 'loading' && material.category === 'video') ||
    (state.kind === 'media' && mediaCategory === 'video' && !mediaFailed);

  return (
    /* On the one dialog primitive: this used to claim `aria-modal` while
       implementing none of it, and sat on a z-index band *below* the real
       modals — so a preview opened over a dialog rendered underneath it
       (finding C1). */
    <Modal
      labelledBy="team-preview-title"
      bare
      backdropClassName="team-preview-backdrop"
      className={`team-preview-dialog${landingPreset ? ' landing-full-view' : ''}`}
      onClose={close}
      data={{
        'data-landing-device': landingPreset?.device,
        'data-landing-scheme': landingPreset?.colorScheme,
        'data-landing-zoom':
          landingPreset?.zoom === undefined ? undefined : String(landingPreset.zoom)
      }}
    >
      {/*
       * The file, not the viewer (the owner, 024): its name and what it is on the
       * left, the way out on the right, as Drive and Frame.io head a viewer.
       * "Safe preview" over every file asked which other kind there was, and a
       * worded "Close preview" button was the loudest thing above the picture.
       */}
      <header className="team-preview-heading">
        <div className="team-preview-title">
          <h2 id="team-preview-title" title={material.name}>
            {material.name}
          </h2>
          <small>{t(CATEGORY_LABEL[material.category ?? 'other'])}</small>
        </div>
        <IconButton title="" label={t('teamPreviewClose')} variant="ghost" onClick={close}>
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </header>
      {toolbar && <div className="landing-full-view-toolbar">{toolbar}</div>}
      <div className="team-preview-content">
        {showStage && (
          <VideoStage
            key={materialId}
            src={state.kind === 'media' ? state.rangeUrl : null}
            poster={poster}
            waiting={state.kind === 'loading' || mediaLoading}
            onReady={markMediaReady}
            onFailed={markMediaFailed}
          />
        )}
        {state.kind === 'loading' && !showStage && (
          <p aria-live="polite">{t('teamPreviewLoading')}</p>
        )}
        {state.kind === 'error' && (
          <p className="team-inline-error" role="alert">
            {/* The three cases with their own advice keep it; everything else asks
                the shared map for a sentence rather than falling back to "could
                not prepare", which told a person nothing they could act on. */}
            {state.code === 'PERMISSION_DENIED'
              ? t('teamPreviewPermissionLost')
              : state.code === 'AGENT_UPDATE_REQUIRED'
                ? t('teamPreviewAgentUpdateRequired')
                : state.code === 'PAIRING_REQUIRED' || state.code === 'CONNECTION_FAILED'
                  ? t('teamPreviewAgentRequired')
                  : state.code
                    ? teamErrorMessage(state.code, t)
                    : t('teamPreviewLoadFailed')}
          </p>
        )}
        {state.kind === 'error' &&
          (state.code === 'PAIRING_REQUIRED' || state.code === 'CONNECTION_FAILED') && (
            <ReconnectAction surface="team_preview" />
          )}
        {state.kind === 'error' &&
          !['PAIRING_REQUIRED', 'CONNECTION_FAILED', 'PERMISSION_DENIED'].includes(state.code) && (
            <Button variant="secondary" onClick={retry}>
              {t('retry')}
            </Button>
          )}
        {state.kind === 'media' && (
          <>
            {mediaLoading && !showStage && (
              <p className="team-preview-media-status" aria-live="polite">
                {t('teamPreviewLoading')}
              </p>
            )}
            {mediaFailed && (
              <>
                <p className="team-inline-error" role="alert">
                  {t('teamPreviewLoadFailed')}
                </p>
                <Button variant="secondary" onClick={retry}>
                  {t('retry')}
                </Button>
              </>
            )}
            {!mediaFailed && mediaCategory === 'image' && (
              <img
                loading="lazy"
                decoding="async"
                src={state.rangeUrl}
                alt={material.name}
                referrerPolicy="no-referrer"
                onLoad={markMediaReady}
                onError={markMediaFailed}
              />
            )}
          </>
        )}
        {state.kind === 'transcript' && (
          <TranscriptPreview
            material={material}
            preview={state}
            onDownload={download}
            onEdit={edit}
          />
        )}
        {state.kind === 'archive' && (
          <ArchiveManifest entries={state.entries} truncated={state.truncated} />
        )}
        {state.kind === 'landing' && <LandingPreviewFrame preview={state} preset={landingPreset} />}
        {state.kind === 'unavailable' && (
          <PreviewUnavailable
            reason={state.reason}
            allowedActions={state.allowedActions}
            variant={landingPreset ? 'landing' : 'default'}
            onDownload={download}
            onNewVersion={createVersion}
          />
        )}
      </div>
    </Modal>
  );
}

function TranscriptPreview({
  material,
  preview,
  onDownload,
  onEdit
}: {
  material: PreviewableMaterial;
  preview: Extract<TeamPreviewResult, { kind: 'transcript' }>;
  onDownload: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const text = transcriptDisplayText(preview.text, material.fileExtension ?? null);
  return (
    <div className="team-transcript-preview">
      {preview.ingestState === 'pending' && <p>{t('teamPreviewTranscriptPending')}</p>}
      {preview.ingestState === 'invalid_encoding' && (
        <p className="team-inline-error" role="alert">
          {t('teamPreviewTranscriptInvalid')}
        </p>
      )}
      {preview.ingestState === 'unavailable' && (
        <p className="team-inline-error" role="alert">
          {t('teamPreviewTranscriptUnavailable')}
        </p>
      )}
      {text !== null && <pre>{text}</pre>}
      {preview.truncated && (
        <p className="team-preview-boundary">
          {t('teamPreviewTranscriptBoundary', { bytes: '1 MiB' })}
        </p>
      )}
      <div className="team-preview-actions">
        {preview.allowedActions.includes('download') && (
          <Button variant="secondary" onClick={onDownload}>
            {t('teamPreviewDownloadFull')}
          </Button>
        )}
        {preview.allowedActions.includes('edit') && (
          <Button variant="secondary" onClick={onEdit}>
            {t('teamPreviewEditText')}
          </Button>
        )}
      </div>
    </div>
  );
}

function ArchiveManifest({
  entries,
  truncated
}: {
  entries: ArchiveView['entries'];
  truncated: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="team-archive-preview">
      <p>{t('teamPreviewArchiveCount', { count: entries.length })}</p>
      {truncated && <p>{t('teamPreviewArchiveTruncated')}</p>}
      <ul>
        {entries.map(entry => (
          <li key={`${entry.directory ? 'd' : 'f'}:${entry.path}`}>
            <span>{entry.path}</span>
            {!entry.directory && <small>{formatBytes(entry.sizeBytes)}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function previewMode(material: PreviewableMaterial) {
  if (material.category === 'video' || material.category === 'image') return 'media' as const;
  if (material.category === 'transcript') return 'transcript' as const;
  if (material.category === 'archive') return 'archive' as const;
  if (material.category === 'landing') return 'landing' as const;
  return 'media' as const;
}

export function transcriptDisplayText(
  text: string | null,
  extension: string | null
): string | null {
  if (text === null) return null;
  const normalizedExtension = extension?.toLocaleLowerCase('en-US');
  if (normalizedExtension !== 'srt' && normalizedExtension !== 'vtt') return text;
  return text
    .replace(/^\uFEFF?WEBVTT[^\n]*\n/iu, '')
    .split(/\r?\n/u)
    .filter(
      line =>
        !/^\s*\d+\s*$/u.test(line) && !/-->/.test(line) && !/^\s*(NOTE|STYLE|REGION)\b/iu.test(line)
    )
    .map(line => line.replace(/<[^>]*>/gu, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : 'PREVIEW_FAILED';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
