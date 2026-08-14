import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  GEO_CODES,
  LANGUAGE_CODES,
  type LibraryStage,
  type TeamFileOperationResult,
  type TeamUploadSession,
  type UploadBatchRequest
} from '@video-compressor/shared';
import {
  teamApi,
  TeamApiError,
  type LibraryUploadBatchStartResult,
  type TeamOperationSnapshot,
  type TeamUploadStartInput
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { resumableUpload } from '../drive/resumableUpload';

const UPLOAD_CONCURRENCY = 4;

type UploadState = 'pending' | 'uploading' | 'succeeded' | 'failed';

interface SelectedUpload {
  clientItemKey: string;
  file: File;
  state: UploadState;
  progress: number;
  errorCode: string | null;
  materialId: string | null;
  operationId: string | null;
  attempt: number;
}

export interface CreativeLibraryUploadClient {
  startLibraryUploadBatch(request: UploadBatchRequest): Promise<LibraryUploadBatchStartResult>;
  startUpload(input: TeamUploadStartInput): Promise<TeamUploadSession>;
  finalizeUpload(input: {
    operationId: string;
    driveFileId: string;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  finalizeLibraryBatchItem(input: {
    teamId: string;
    batchId: string;
    clientItemKey: string;
    materialId: string;
  }): Promise<{ state: 'succeeded'; materialId: string; reused: boolean }>;
  failLibraryBatchItem(input: {
    teamId: string;
    batchId: string;
    clientItemKey: string;
    errorCode: string;
  }): Promise<{ state: 'failed'; errorCode: string }>;
  getOperation(teamId: string, operationId: string): Promise<TeamOperationSnapshot>;
  cancelOperation(teamId: string, operationId: string): Promise<TeamOperationSnapshot>;
}

const defaultClient: CreativeLibraryUploadClient = teamApi;

function selectedFile(file: File, index: number): SelectedUpload {
  return {
    clientItemKey: `file-${crypto.randomUUID()}-${index}`,
    file,
    state: 'pending',
    progress: 0,
    errorCode: null,
    materialId: null,
    operationId: null,
    attempt: 0
  };
}

function safeErrorCode(cause: unknown): string {
  if (cause instanceof TeamApiError) return cause.code;
  const message = cause instanceof Error ? cause.message : '';
  return message.match(/^[A-Z][A-Z0-9_]{0,63}$/u)?.[0] ?? 'DRIVE_UNAVAILABLE';
}

export async function runWithUploadConcurrency<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  concurrency = UPLOAD_CONCURRENCY
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, () => worker())
  );
}

export function BulkUploadDialog({
  teamId,
  initialStage,
  client = defaultClient,
  onClose,
  onItemReady,
  onFinished
}: {
  teamId: string;
  initialStage: LibraryStage;
  client?: CreativeLibraryUploadClient;
  onClose: () => void;
  onItemReady: (input: {
    materialId: string;
    file: File;
    stage: LibraryStage;
    offer: string;
    geo: string;
    language: string;
  }) => void;
  onFinished: () => void;
}) {
  const { t } = useI18n();
  const [stage, setStage] = useState<LibraryStage>(initialStage);
  const [offer, setOffer] = useState('');
  const [geo, setGeo] = useState('UA');
  const [languageMode, setLanguageMode] = useState<'auto' | 'manual'>('auto');
  const [language, setLanguage] = useState('uk');
  const [items, setItems] = useState<SelectedUpload[]>([]);
  const [batch, setBatch] = useState<LibraryUploadBatchStartResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = useRef(false);

  const updateItem = (key: string, patch: Partial<SelectedUpload>) => {
    setItems(current =>
      current.map(item => (item.clientItemKey === key ? { ...item, ...patch } : item))
    );
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (selected.length === 0) return;
    setItems(current => [
      ...current,
      ...selected.slice(0, 500 - current.length).map((file, index) => selectedFile(file, index))
    ]);
  };

  const completeBatchItem = async (
    currentBatch: LibraryUploadBatchStartResult,
    item: SelectedUpload
  ) => {
    let materialId = item.materialId;
    let operationId = item.operationId;

    if (!materialId && operationId) {
      const operation = await client.getOperation(teamId, operationId);
      if (operation.state === 'succeeded' && operation.resultMaterialId) {
        materialId = operation.resultMaterialId;
      } else if (operation.state === 'pending' || operation.state === 'running') {
        await client.cancelOperation(teamId, operationId).catch(() => undefined);
        operationId = null;
      }
    }

    if (!materialId) {
      const attempt = item.attempt + 1;
      const idempotencyKey = `library:${currentBatch.batchId}:${item.clientItemKey}:${attempt}`;
      const session = await client.startUpload({
        teamId,
        destinationFolderId: currentBatch.destinationFolderId,
        name: item.file.name,
        mimeType: item.file.type || 'application/octet-stream',
        sizeBytes: item.file.size,
        conflictMode: 'keep_both',
        replaceMaterialId: null,
        versionOfMaterialId: null,
        idempotencyKey
      });
      operationId = session.operationId;
      updateItem(item.clientItemKey, { operationId, attempt });
      if (!session.sessionUri || session.sessionUnavailable) throw new Error('WRONG_STATE');
      const uploaded = await resumableUpload({
        source: item.file,
        sessionUri: session.sessionUri,
        operationId: session.operationId,
        idempotencyKey,
        finalize: client.finalizeUpload,
        onProgress: (completed, total) =>
          updateItem(item.clientItemKey, {
            progress: Math.min(95, Math.round((completed / Math.max(total, 1)) * 95))
          })
      });
      if (!uploaded.materialId) throw new Error('INVALID_RESPONSE');
      materialId = uploaded.materialId;
      updateItem(item.clientItemKey, { materialId, operationId });
    }

    await client.finalizeLibraryBatchItem({
      teamId,
      batchId: currentBatch.batchId,
      clientItemKey: item.clientItemKey,
      materialId
    });
    updateItem(item.clientItemKey, {
      state: 'succeeded',
      progress: 100,
      errorCode: null,
      materialId,
      operationId
    });
    if (!closed.current) {
      onItemReady({
        materialId,
        file: item.file,
        stage,
        offer: offer.trim(),
        geo,
        language: languageMode === 'manual' ? language : 'unknown'
      });
    }
  };

  const runItems = async (
    currentBatch: LibraryUploadBatchStartResult,
    pending: SelectedUpload[]
  ) => {
    setBusy(true);
    setError(null);
    await runWithUploadConcurrency(pending, async item => {
      updateItem(item.clientItemKey, { state: 'uploading', errorCode: null });
      try {
        await completeBatchItem(currentBatch, item);
      } catch (cause) {
        const errorCode = safeErrorCode(cause);
        updateItem(item.clientItemKey, { state: 'failed', errorCode });
        await client
          .failLibraryBatchItem({
            teamId,
            batchId: currentBatch.batchId,
            clientItemKey: item.clientItemKey,
            errorCode
          })
          .catch(() => undefined);
      }
    });
    setBusy(false);
    onFinished();
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (items.length < 1 || !offer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const started = await client.startLibraryUploadBatch({
        teamId,
        stage,
        offer,
        geo,
        languageMode,
        language: languageMode === 'manual' ? language : null,
        items: items.map(item => ({
          clientItemKey: item.clientItemKey,
          name: item.file.name,
          mimeType: item.file.type || 'application/octet-stream',
          sizeBytes: item.file.size
        }))
      });
      setBatch(started);
      await runItems(started, items);
    } catch (cause) {
      setError(safeErrorCode(cause));
      setBusy(false);
    }
  };

  const failed = useMemo(() => items.filter(item => item.state === 'failed'), [items]);
  const completed = items.filter(item => item.state === 'succeeded').length;

  return (
    <Modal
      labelledBy="creative-library-upload-title"
      onClose={() => {
        closed.current = true;
        onClose();
      }}
      closeLabel={t('teamCancel')}
      initialFocus="#creative-library-files"
      size="lg"
    >
      <form
        className="team-dialog-form creative-library-upload"
        onSubmit={event => void start(event)}
      >
        <div>
          <p className="team-workspace-eyebrow">{t('creativeLibraryEyebrow')}</p>
          <h2 id="creative-library-upload-title">{t('creativeLibraryBulkTitle')}</h2>
          <p>{t('creativeLibraryBulkHint')}</p>
        </div>

        {!batch && (
          <div className="creative-library-upload-fields">
            <label>
              <span>{t('creativeLibraryFiles')}</span>
              <input
                id="creative-library-files"
                type="file"
                multiple
                required={items.length === 0}
                onChange={chooseFiles}
              />
            </label>
            <label>
              <span>{t('creativeLibraryStage')}</span>
              <select
                value={stage}
                onChange={event => setStage(event.target.value as LibraryStage)}
              >
                <option value="finds">{t('creativeLibraryFinds')}</option>
                <option value="library">{t('creativeLibraryTitle')}</option>
              </select>
            </label>
            <label>
              <span>{t('creativeLibraryOffer')}</span>
              <input
                value={offer}
                maxLength={120}
                required
                onChange={event => setOffer(event.target.value)}
              />
            </label>
            <label>
              <span>{t('creativeLibraryGeo')}</span>
              <select value={geo} onChange={event => setGeo(event.target.value)}>
                {GEO_CODES.map(code => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('creativeLibraryLanguageMode')}</span>
              <select
                value={languageMode}
                onChange={event => setLanguageMode(event.target.value as 'auto' | 'manual')}
              >
                <option value="auto">{t('creativeLibraryLanguageAuto')}</option>
                <option value="manual">{t('creativeLibraryLanguageManual')}</option>
              </select>
            </label>
            {languageMode === 'manual' && (
              <label>
                <span>{t('creativeLibraryLanguage')}</span>
                <select value={language} onChange={event => setLanguage(event.target.value)}>
                  {LANGUAGE_CODES.map(code => (
                    <option key={code}>{code}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {items.length > 0 && (
          <div className="creative-library-upload-summary" aria-live="polite">
            <strong>{t('creativeLibrarySelectedFiles', { count: items.length })}</strong>
            <span>{t('creativeLibraryUploadCompleted', { completed, total: items.length })}</span>
            <progress max={items.length} value={completed} />
          </div>
        )}

        <ul className="creative-library-upload-items">
          {items.map(item => (
            <li key={item.clientItemKey} data-state={item.state}>
              <span title={item.file.name}>{item.file.name}</span>
              <progress max={100} value={item.progress} aria-label={item.file.name} />
              <small>
                {item.state === 'failed'
                  ? t('creativeLibraryUploadFailed', { code: item.errorCode ?? 'UNKNOWN' })
                  : t(
                      `creativeLibraryUploadState${item.state[0].toUpperCase()}${item.state.slice(1)}` as
                        | 'creativeLibraryUploadStatePending'
                        | 'creativeLibraryUploadStateUploading'
                        | 'creativeLibraryUploadStateSucceeded'
                    )}
              </small>
            </li>
          ))}
        </ul>

        {error && (
          <p className="team-inline-error">{t('creativeLibraryBulkFailed', { code: error })}</p>
        )}
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {completed > 0 ? t('creativeLibraryDone') : t('teamCancel')}
          </Button>
          {!batch && (
            <Button type="submit" variant="primary" loading={busy} disabled={items.length === 0}>
              {t('creativeLibraryUploadStart')}
            </Button>
          )}
          {batch && failed.length > 0 && !busy && (
            <Button type="button" variant="primary" onClick={() => void runItems(batch, failed)}>
              {t('creativeLibraryRetryFailed', { count: failed.length })}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
