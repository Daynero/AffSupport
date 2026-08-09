import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { LandingPreviewFrame, type LandingPreviewView } from './LandingPreviewFrame';
import { PreviewUnavailable } from './PreviewUnavailable';

type AgentRequest = Extract<TeamPreviewResult, { kind: 'agent' }>;
type AgentUnavailable = Extract<TeamAgentPreviewResult, { kind: 'unavailable' }>;
type ArchiveView = Extract<TeamAgentPreviewResult, { kind: 'archive' }>;

export interface MaterialPreviewClient {
  requestPreview: (
    teamId: string,
    materialId: string,
    mode: 'media' | 'transcript' | 'archive' | 'landing'
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
  requestPreview: (teamId, materialId, mode) => teamApi.previewMaterial(teamId, materialId, mode),
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
  material: CatalogMaterialItem;
  client?: MaterialPreviewClient;
  landingPreset?: LandingViewerPreset;
  toolbar?: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<DisplayState>({ kind: 'loading' });
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

  useEffect(() => {
    let active = true;
    operationId.current = null;
    closed.current.clear();
    setState({ kind: 'loading' });
    const mode = previewMode(material);
    void client
      .requestPreview(teamId, material.id, mode)
      .then(async result => {
        if (!active) return;
        if (result.kind !== 'agent') {
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
        if (
          result.previewKind === 'landing' &&
          local.kind === 'landing' &&
          local.validation &&
          client.commitLandingValidation
        ) {
          void client
            .commitLandingValidation({
              teamId,
              materialId: material.id,
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
        if (active) setState({ kind: 'error', code: errorCode(error) });
      });
    return () => {
      active = false;
      void closeOperation(operationId.current);
    };
  }, [client, closeOperation, material, teamId]);

  const close = () => {
    void closeOperation(operationId.current).finally(onClose);
  };
  const download = () => client.downloadMaterial?.(teamId, material.id);
  const edit = () => client.editText?.(teamId, material.id);
  const createVersion = () => client.createVersion?.(teamId, material.id);

  return (
    <div className="team-preview-backdrop" role="presentation">
      <section
        className={`team-preview-dialog${landingPreset ? ' landing-full-view' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-preview-title"
        data-landing-device={landingPreset?.device}
        data-landing-scheme={landingPreset?.colorScheme}
        data-landing-zoom={landingPreset?.zoom}
      >
        <header className="team-preview-heading">
          <div>
            <p>{t('teamPreviewEyebrow')}</p>
            <h2 id="team-preview-title">{material.name}</h2>
          </div>
          <Button type="button" variant="ghost" onClick={close}>
            {t('teamPreviewClose')}
          </Button>
        </header>
        {toolbar && <div className="landing-full-view-toolbar">{toolbar}</div>}
        <div className="team-preview-content">
          {state.kind === 'loading' && <p aria-live="polite">{t('teamPreviewLoading')}</p>}
          {state.kind === 'error' && (
            <p className="team-inline-error" role="alert">
              {state.code === 'PERMISSION_DENIED'
                ? t('teamPreviewPermissionLost')
                : state.code === 'AGENT_UPDATE_REQUIRED'
                  ? t('teamPreviewAgentUpdateRequired')
                  : state.code === 'PAIRING_REQUIRED' || state.code === 'CONNECTION_FAILED'
                    ? t('teamPreviewAgentRequired')
                    : t('teamPreviewLoadFailed')}
            </p>
          )}
          {state.kind === 'media' && material.category === 'video' && (
            <video
              ref={element => element?.setAttribute('referrerpolicy', 'no-referrer')}
              controls
              preload="metadata"
              src={state.rangeUrl}
            />
          )}
          {state.kind === 'media' && material.category === 'image' && (
            <img src={state.rangeUrl} alt={material.name} referrerPolicy="no-referrer" />
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
          {state.kind === 'landing' && (
            <LandingPreviewFrame preview={state} preset={landingPreset} />
          )}
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
      </section>
    </div>
  );
}

function TranscriptPreview({
  material,
  preview,
  onDownload,
  onEdit
}: {
  material: CatalogMaterialItem;
  preview: Extract<TeamPreviewResult, { kind: 'transcript' }>;
  onDownload: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const text = transcriptDisplayText(preview.text, material.fileExtension);
  return (
    <div className="team-transcript-preview">
      {preview.ingestState === 'pending' && <p>{t('teamPreviewTranscriptPending')}</p>}
      {preview.ingestState === 'invalid_encoding' && (
        <p className="team-inline-error">{t('teamPreviewTranscriptInvalid')}</p>
      )}
      {preview.ingestState === 'unavailable' && (
        <p className="team-inline-error">{t('teamPreviewTranscriptUnavailable')}</p>
      )}
      {text !== null && <pre>{text}</pre>}
      {preview.truncated && (
        <p className="team-preview-boundary">
          {t('teamPreviewTranscriptBoundary', { bytes: '1 MiB' })}
        </p>
      )}
      <div className="team-preview-actions">
        {preview.allowedActions.includes('download') && (
          <Button type="button" onClick={onDownload}>
            {t('teamPreviewDownloadFull')}
          </Button>
        )}
        {preview.allowedActions.includes('edit') && (
          <Button type="button" onClick={onEdit}>
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

function previewMode(material: CatalogMaterialItem) {
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
