import { useRef, useState, type ChangeEvent } from 'react';
import type {
  CatalogMaterialItem,
  TeamAnalyticsAction,
  TeamAnalyticsOutcome,
  TeamAnalyticsStorage,
  TeamDownloadGrantResult,
  TeamFileOperationResult,
  TeamPermissions
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { downloadTeamFileWithAgent } from '../../api/client';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  completeTeamFileAttempt,
  startTeamFileAttempt,
  teamAnalyticsSizeBucket
} from '../../analytics/service';
import { resumableUpload } from '../drive/resumableUpload';

export interface TeamFileUploadInput {
  teamId: string;
  destinationFolderId: string;
  file: File;
  conflictMode: 'cancel' | 'keep_both' | 'replace';
  replaceMaterialId: string | null;
  versionOfMaterialId: string | null;
}

export interface MaterialActionsClient {
  uploadFile(input: TeamFileUploadInput): Promise<TeamFileOperationResult>;
  requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser' | 'agent'
  ): Promise<TeamDownloadGrantResult>;
  downloadWithAgent(input: {
    transferUrl: string;
    transferGrant: Extract<TeamDownloadGrantResult, { kind: 'agent' }>['grant'];
    fileName: string;
  }): Promise<unknown>;
  renameMaterial(input: {
    teamId: string;
    materialId: string;
    newName: string;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  moveMaterial(input: {
    teamId: string;
    materialId: string;
    destinationFolderId: string;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  trashMaterial(input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  restoreMaterial(input: {
    teamId: string;
    materialId: string;
    destinationFolderId?: string | null;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
}

export async function uploadTeamFile(input: TeamFileUploadInput) {
  const idempotencyKey = crypto.randomUUID();
  const session = await teamApi.startUpload({
    teamId: input.teamId,
    destinationFolderId: input.destinationFolderId,
    name: input.file.name,
    mimeType: input.file.type || 'application/octet-stream',
    sizeBytes: input.file.size,
    conflictMode: input.conflictMode,
    replaceMaterialId: input.replaceMaterialId,
    versionOfMaterialId: input.versionOfMaterialId,
    idempotencyKey
  });
  if (!session.sessionUri || session.sessionUnavailable) throw new Error('WRONG_STATE');
  return resumableUpload({
    source: input.file,
    sessionUri: session.sessionUri,
    operationId: session.operationId,
    idempotencyKey,
    finalize: teamApi.finalizeUpload
  });
}

const defaultClient: MaterialActionsClient = {
  uploadFile: uploadTeamFile,
  requestDownload: (teamId, materialId, consumer) =>
    teamApi.requestDownload(teamId, materialId, consumer),
  downloadWithAgent: downloadTeamFileWithAgent,
  renameMaterial: input => teamApi.renameMaterial(input),
  moveMaterial: input => teamApi.moveMaterial(input),
  trashMaterial: input => teamApi.trashMaterial(input),
  restoreMaterial: input => teamApi.restoreMaterial(input)
};

export function MaterialActions({
  teamId,
  material,
  permissions,
  client = defaultClient,
  onChanged,
  onEditText,
  onProcess,
  storageKind = null,
  trashed = false,
  replaceMaterialId = null,
  destinationFolderId = null
}: {
  teamId: string;
  material: CatalogMaterialItem;
  permissions: TeamPermissions;
  client?: MaterialActionsClient;
  onChanged: () => void;
  onEditText?: () => void;
  onProcess?: () => void;
  storageKind?: TeamAnalyticsStorage | null;
  trashed?: boolean;
  replaceMaterialId?: string | null;
  destinationFolderId?: string | null;
}) {
  const { t } = useI18n();
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(material.name);
  const [moving, setMoving] = useState(false);
  const [destination, setDestination] = useState('');
  const downloadAnchor = useRef<HTMLAnchorElement | null>(null);
  const attemptNumbers = useRef<Partial<Record<TeamAnalyticsAction, number>>>({});
  const isFolder = material.kind === 'folder';
  const isEditableText =
    material.kind === 'file' &&
    material.fileExtension?.toLowerCase() === 'txt' &&
    material.transcriptIngestState === 'full';

  const beginAttempt = (action: TeamAnalyticsAction, sizeBytes = material.sizeBytes) => {
    if (!storageKind) return null;
    const attemptNumber = (attemptNumbers.current[action] ?? 0) + 1;
    attemptNumbers.current[action] = attemptNumber;
    return startTeamFileAttempt({
      action,
      storageKind,
      sizeBucket: teamAnalyticsSizeBucket(sizeBytes),
      cacheState: 'unknown',
      attemptNumber
    });
  };

  const run = async (action: TeamAnalyticsAction, work: () => Promise<unknown>) => {
    const attempt = beginAttempt(action);
    setBusy(true);
    setError(null);
    try {
      await work();
      if (attempt) completeTeamFileAttempt(attempt, { outcome: 'success', retryable: false });
      onChanged();
      return true;
    } catch (caught) {
      if (attempt) {
        completeTeamFileAttempt(attempt, {
          outcome: analyticsOutcome(caught),
          retryable: retryableError(caught)
        });
      }
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const upload = async (
    file: File,
    conflictMode: TeamFileUploadInput['conflictMode'],
    exactReplacement: string | null = null,
    versionOf: string | null = null
  ) => {
    const uploadDestination = isFolder ? material.id : destinationFolderId;
    if (!uploadDestination) {
      setError('INVALID_INPUT');
      return;
    }
    const attempt = beginAttempt('upload', file.size);
    setBusy(true);
    setError(null);
    try {
      await client.uploadFile({
        teamId,
        destinationFolderId: uploadDestination,
        file,
        conflictMode,
        replaceMaterialId: exactReplacement,
        versionOfMaterialId: versionOf
      });
      if (attempt) completeTeamFileAttempt(attempt, { outcome: 'success', retryable: false });
      setConflict(false);
      setPendingFile(null);
      onChanged();
    } catch (caught) {
      if (attempt) {
        completeTeamFileAttempt(attempt, {
          outcome: analyticsOutcome(caught),
          retryable: retryableError(caught)
        });
      }
      if (errorCode(caught) === 'NAME_CONFLICT') {
        setPendingFile(file);
        setConflict(true);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const selectUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void upload(file, 'cancel');
  };

  const download = () =>
    void run('download', async () => {
      try {
        const grant = await client.requestDownload(teamId, material.id, 'browser');
        if (grant.kind === 'agent') {
          await client.downloadWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: material.name
          });
          return;
        }
        const anchor = document.createElement('a');
        anchor.href = grant.rangeUrl;
        anchor.download = material.name;
        anchor.rel = 'noreferrer';
        downloadAnchor.current = anchor;
        anchor.click();
      } catch (caught) {
        if (errorCode(caught) !== 'AGENT_REQUIRED') throw caught;
        const grant = await client.requestDownload(teamId, material.id, 'agent');
        if (grant.kind !== 'agent') throw new Error('INVALID_RESPONSE', { cause: caught });
        await client.downloadWithAgent({
          transferUrl: grant.transferUrl,
          transferGrant: grant.grant,
          fileName: material.name
        });
      }
    });

  return (
    <div className="team-material-actions">
      <div className="team-material-action-buttons">
        {isFolder && permissions.upload && (
          <label className="button button-secondary">
            {t('teamFileUpload')}
            <input type="file" aria-label={t('teamFileUpload')} hidden onChange={selectUpload} />
          </label>
        )}
        {!isFolder && permissions.download && (
          <Button type="button" variant="ghost" disabled={busy} onClick={download}>
            {t('teamFileDownload')}
          </Button>
        )}
        {!isFolder && permissions.upload && destinationFolderId && (
          <label className="button button-ghost">
            {t('teamFileNewVersion')}
            <input
              type="file"
              aria-label={t('teamFileNewVersion')}
              hidden
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void upload(file, 'cancel', null, material.id);
              }}
            />
          </label>
        )}
        {!isFolder && permissions.edit && (
          <>
            <Button type="button" variant="ghost" onClick={() => setRenaming(value => !value)}>
              {t('teamFileRename')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMoving(value => !value)}>
              {t('teamFileMove')}
            </Button>
          </>
        )}
        {!isFolder && permissions.edit && isEditableText && onEditText && (
          <Button type="button" variant="ghost" onClick={onEditText}>
            {t('teamFileEditText')}
          </Button>
        )}
        {!isFolder && permissions.process && (
          <Button type="button" variant="ghost" onClick={onProcess}>
            {t('teamFileProcess')}
          </Button>
        )}
        {!isFolder && permissions.delete && !trashed && (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run('trash', () =>
                client.trashMaterial({
                  teamId,
                  materialId: material.id,
                  idempotencyKey: crypto.randomUUID()
                })
              )
            }
          >
            {t('teamFileTrash')}
          </Button>
        )}
        {!isFolder && permissions.delete && trashed && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run('trash', () =>
                client.restoreMaterial({
                  teamId,
                  materialId: material.id,
                  idempotencyKey: crypto.randomUUID()
                })
              )
            }
          >
            {t('teamFileRestore')}
          </Button>
        )}
      </div>

      {renaming && (
        <form
          className="team-material-inline-form"
          onSubmit={event => {
            event.preventDefault();
            void run('rename', () =>
              client.renameMaterial({
                teamId,
                materialId: material.id,
                newName,
                conflictMode: 'cancel',
                idempotencyKey: crypto.randomUUID()
              })
            ).then(succeeded => {
              if (succeeded) setRenaming(false);
            });
          }}
        >
          <label>
            {t('teamFileNewName')}
            <input value={newName} onChange={event => setNewName(event.target.value)} />
          </label>
          <Button type="submit" loading={busy}>
            {t('teamFileRename')}
          </Button>
        </form>
      )}

      {moving && (
        <form
          className="team-material-inline-form"
          onSubmit={event => {
            event.preventDefault();
            void run('move', () =>
              client.moveMaterial({
                teamId,
                materialId: material.id,
                destinationFolderId: destination,
                conflictMode: 'cancel',
                idempotencyKey: crypto.randomUUID()
              })
            ).then(succeeded => {
              if (succeeded) setMoving(false);
            });
          }}
        >
          <label>
            {t('teamFileDestination')}
            <input value={destination} onChange={event => setDestination(event.target.value)} />
          </label>
          <Button type="submit" loading={busy}>
            {t('teamFileMove')}
          </Button>
        </form>
      )}

      {conflict && pendingFile && (
        <div className="team-file-conflict" role="alert">
          <p>{t('teamFileNameConflict')}</p>
          <div>
            <Button type="button" onClick={() => void upload(pendingFile, 'keep_both')}>
              {t('teamFileKeepBoth')}
            </Button>
            {permissions.edit && replaceMaterialId && (
              <Button
                type="button"
                variant="danger"
                onClick={() => void upload(pendingFile, 'replace', replaceMaterialId)}
              >
                {t('teamFileReplaceExact')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => setConflict(false)}>
              {t('teamFileCancel')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : 'PROCESS_FAILED';
}

function errorMessage(error: unknown) {
  return errorCode(error);
}

function retryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return ['RATE_LIMITED', 'DRIVE_UNAVAILABLE', 'DELIVERY_UNAVAILABLE'].includes(errorCode(error));
}

function analyticsOutcome(error: unknown): TeamAnalyticsOutcome {
  const code = errorCode(error);
  if (code === 'UNSUPPORTED_MEDIA' || code === 'TOO_LARGE') return 'unsupported';
  if (code === 'ABORTED' || code === 'CANCELED') return 'cancelled';
  if (
    [
      'AGENT_REQUIRED',
      'AGENT_UPDATE_REQUIRED',
      'NAME_CONFLICT',
      'NOT_A_MEMBER',
      'PERMISSION_DENIED',
      'ROOT_ESCAPE'
    ].includes(code)
  ) {
    return 'blocked';
  }
  return 'failure';
}
