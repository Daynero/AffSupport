import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Folder, Image, RefreshCw, Upload, X } from 'lucide-react';
import type {
  CatalogImageEntryState,
  CatalogImageImportState,
  CatalogImageDictionaryEntry
} from '@video-compressor/shared';
import type { CatalogImageClient } from '../../api/team-catalog-images';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, IconButton, Modal, Textarea } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { teamErrorMessageFor } from '../errors';
import { SettingsSection } from '../workspace/SettingsSection';
import { CATALOG_IMAGE_PROMPT, recordCatalogImagePrompt } from './catalogImagePrompt';
import { useCatalogImageImport } from './useCatalogImageImport';

const stageKeys: Record<CatalogImageEntryState | CatalogImageImportState, TranslationKey> = {
  collecting: 'catalogImagesStageCollecting',
  enumerating: 'catalogImagesStageEnumerating',
  sealed: 'catalogImagesStageSealed',
  running: 'catalogImagesStageRunning',
  completed: 'catalogImagesStageCompleted',
  partial: 'catalogImagesStagePartial',
  failed: 'catalogImagesStageFailed',
  cancelled: 'catalogImagesStageCancelled',
  expired: 'catalogImagesStageExpired',
  awaiting_reconciliation: 'catalogImagesStageUncertain',
  waiting_source: 'catalogImagesStageWaiting',
  staged: 'catalogImagesStageStaged',
  validating: 'catalogImagesStageValidating',
  deduplicating: 'catalogImagesStageDeduplicating',
  publishing: 'catalogImagesStagePublishing',
  verifying_origin: 'catalogImagesStageVerifying',
  verifying_public: 'catalogImagesStageVerifyingPublic',
  committing: 'catalogImagesStageCommitting',
  ready: 'catalogImagesStageReady',
  reused: 'catalogImagesStageReused'
};

/** Existing controls and the workspace's single Realtime owner serve both sources. */
export function CatalogImageImport({
  teamId,
  client,
  folderClient,
  legacySources,
  onPool,
  legacy
}: {
  teamId: string;
  client: CatalogImageClient;
  folderClient?: FolderPickerClient;
  legacySources?: () => Promise<readonly string[]>;
  onPool: (count: number) => void;
  legacy?: ReactNode;
}) {
  const { t } = useI18n();
  const state = useCatalogImageImport(teamId, client);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const promptTitleId = useId();
  const revokeTitleId = useId();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [over, setOver] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [manualPrompt, setManualPrompt] = useState(false);
  const [revoking, setRevoking] = useState<CatalogImageDictionaryEntry | null>(null);
  const [shownFiles, setShownFiles] = useState(10);
  const [shownEntries, setShownEntries] = useState(10);
  const copyFlow = useRef<string | null>(null);
  const enabled = Boolean(
    state.capabilities?.enabled && state.capabilities.importEnabled && state.capabilities.canManage
  );
  useEffect(() => {
    if (state.capabilities?.mode === 'v2' && state.inventory) onPool(state.inventory.total);
  }, [onPool, state.capabilities?.mode, state.inventory]);
  useEffect(() => {
    setShownEntries(10);
  }, [state.job?.id]);

  const copyPrompt = async () => {
    const flow = crypto.randomUUID();
    copyFlow.current = flow;
    recordCatalogImagePrompt('requested', flow);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(CATALOG_IMAGE_PROMPT);
      setCopyState('copied');
      recordCatalogImagePrompt('succeeded', flow);
    } catch {
      setCopyState('failed');
      recordCatalogImagePrompt('failed', flow);
    }
  };
  const openPrompt = () => {
    setManualPrompt(true);
    recordCatalogImagePrompt('manual_fallback', copyFlow.current ?? crypto.randomUUID());
  };
  const jobDone =
    state.job &&
    ['completed', 'partial', 'failed', 'cancelled', 'expired'].includes(state.job.state);

  return (
    <>
      {state.capabilities?.mode === 'legacy' && legacy}
      <SettingsSection
        icon={Image}
        titleId="catalog-r2-images-title"
        title={t('catalogImagesTitle')}
        description={t('catalogImagesDescription')}
        aside={
          state.inventory
            ? t('productCatalogImagesPool', { count: state.inventory.total })
            : undefined
        }
        className="product-catalog-pool"
      >
        {state.loading && <p role="status">{t('catalogImagesLoading')}</p>}
        {state.capabilities && !state.capabilities.enabled && (
          <p className="team-inline-note">{t('catalogImagesSetupRequired')}</p>
        )}
        {state.capabilities?.enabled && !state.capabilities.importEnabled && (
          <p className="team-inline-note">{t('catalogImagesImportsPaused')}</p>
        )}
        {enabled && <p className="team-inline-note">{t('catalogImagesPublicNotice')}</p>}
        {enabled && state.capabilities?.mode === 'legacy' && legacySources && (
          <div>
            <p className="field-hint">{t('catalogImagesMigrateHint')}</p>
            <Button
              type="button"
              variant="secondary"
              disabled={state.busy}
              onClick={() => void state.start(legacySources)}
            >
              {t('catalogImagesMigrateExisting')}
            </Button>
          </div>
        )}
        {state.error !== null && (
          <p role="alert" className="team-inline-error">
            {teamErrorMessageFor(state.error, t)}
          </p>
        )}
        {state.inventory && (
          <p role="status">
            {t('catalogImagesInventory', {
              matched: state.inventory.total - state.inventory.unclassified,
              random: state.inventory.unclassified
            })}
          </p>
        )}
        {state.dictionary && state.dictionary.items.length > 0 && (
          <>
            <ul className="product-catalog-sources">
              {state.dictionary.items.map(entry => (
                <li key={entry.id}>
                  <span className="product-catalog-source-name">
                    {entry.classification.mode === 'matched'
                      ? `${entry.classification.garment} / ${entry.classification.color}`
                      : t('catalogImagesRandomMode')}
                  </span>
                  <a href={entry.publicUrl} target="_blank" rel="noopener noreferrer">
                    {t('catalogImagesOpenPicture')}
                  </a>
                  {state.capabilities?.canManage && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={state.busy}
                        onClick={() => void state.removePicture(entry)}
                      >
                        {t('catalogImagesRemovePicture')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={state.busy}
                        onClick={() => setRevoking(entry)}
                      >
                        {t('catalogImagesRevokePicture')}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {state.dictionary.hasMore && (
              <Button type="button" variant="link" onClick={() => void state.morePictures()}>
                {t('catalogImagesNextPictures')}
              </Button>
            )}
          </>
        )}
        {state.revocationRequested && <p role="status">{t('catalogImagesRevocationQueued')}</p>}
        {enabled && (
          <>
            <div
              className={`drop-zone${over ? ' is-dragging' : ''}${state.busy ? ' is-disabled' : ''}`}
              role="group"
              aria-label={t('catalogImagesDrop')}
              onDragOver={event => {
                event.preventDefault();
                if (!state.busy) setOver(true);
              }}
              onDragLeave={event => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget instanceof Node ? event.relatedTarget : null
                  )
                )
                  setOver(false);
              }}
              onDrop={event => {
                event.preventDefault();
                setOver(false);
                if (!state.busy) state.queueFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <p>{t('catalogImagesDrop')}</p>
              <Button
                type="button"
                variant="secondary"
                disabled={state.busy}
                onClick={() => input.current?.click()}
              >
                {t('catalogImagesChooseFiles')}
              </Button>
              <input
                ref={input}
                id={inputId}
                hidden
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp"
                aria-label={t('catalogImagesChooseFiles')}
                disabled={state.busy}
                onChange={event => {
                  state.queueFiles(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </div>
            <div className="settings-section-actions">
              {folderClient && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => setPickingFolder(true)}
                >
                  <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t('catalogImagesChooseDrive')}
                </Button>
              )}
              <Button
                type="button"
                variant="primary"
                loading={state.busy}
                disabled={state.busy || (!state.folder && state.files.length === 0)}
                onClick={() => void state.start()}
              >
                <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('catalogImagesAnalyzeUpload')}
              </Button>
            </div>
            {state.folder && <p>{t('catalogImagesSelectedFolder', { name: state.folder.name })}</p>}
            {state.files.length > 0 && (
              <>
                <p>{t('catalogImagesQueued', { count: state.files.length })}</p>
                <ul className="product-catalog-sources">
                  {state.files.slice(0, shownFiles).map(item => (
                    <li key={item.key}>
                      <span className="product-catalog-source-name">{item.file.name}</span>
                      <IconButton
                        variant="ghost"
                        label={t('productCatalogImagesRemove', { name: item.file.name })}
                        disabled={state.busy}
                        onClick={() => state.removeFile(item.key)}
                      >
                        <X aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
                {shownFiles < state.files.length && (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => setShownFiles(count => count + 50)}
                  >
                    {t('catalogImagesShowMore')}
                  </Button>
                )}
              </>
            )}
            {state.busy && (
              <p role="status">
                {t('catalogImagesTransferBytes', {
                  loaded: state.uploadedBytes,
                  total: state.totalBytes
                })}
              </p>
            )}
            {state.waitingUploads > 0 && <p role="status">{t('catalogImagesWaitingCapacity')}</p>}
          </>
        )}
        <p className="field-hint">{t('catalogImagesHelpClothing')}</p>
        <p className="field-hint">{t('catalogImagesHelpRandom')}</p>
        <p className="field-hint">{t('catalogImagesHelpMix')}</p>
        <p className="field-hint">{t('catalogImagesHelpNames')}</p>
        <Button type="button" variant="link" onClick={() => void copyPrompt()}>
          {t('catalogImagesCopyPrompt')}
        </Button>
        {copyState === 'copied' && (
          <p role="status">
            <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('catalogImagesPromptCopied')}
          </p>
        )}
        {copyState === 'failed' && (
          <div role="status">
            <p>{t('catalogImagesPromptCopyFailed')}</p>
            <Button type="button" variant="link" onClick={openPrompt}>
              {t('catalogImagesOpenPrompt')}
            </Button>
          </div>
        )}
        <div className="settings-section-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={state.loading}
            onClick={() => void state.refresh()}
          >
            <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('catalogImagesRefresh')}
          </Button>
        </div>
        {state.imports && state.imports.items.length > 0 && (
          <>
            <p>{t('catalogImagesRecentImports')}</p>
            <div className="settings-section-actions">
              {state.imports.items.map(item => (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  aria-pressed={state.job?.id === item.id}
                  disabled={state.busy}
                  onClick={() => void state.selectJob(item.id)}
                >
                  {t(stageKeys[item.state])} · {item.counts.ready + item.counts.reused}/
                  {item.counts.total}
                </Button>
              ))}
            </div>
            {state.imports.hasMore && (
              <Button type="button" variant="link" onClick={() => void state.moreJobs()}>
                {t('catalogImagesShowMore')}
              </Button>
            )}
          </>
        )}
        {state.job && (
          <section aria-label={t('catalogImagesImportStatus')}>
            <p role="status">{t(stageKeys[state.job.state])}</p>
            {state.job.errorCode && (
              <p role="alert" className="team-inline-error">
                {teamErrorMessageFor({ code: state.job.errorCode }, t)}
              </p>
            )}
            {state.job.hasMoreSources && enabled && jobDone && (
              <Button
                type="button"
                variant="secondary"
                disabled={state.busy}
                onClick={() => void state.continueImport()}
              >
                {t('catalogImagesContinueImport')}
              </Button>
            )}
            <p>
              {t('catalogImagesJobCounts', {
                ready: state.job.counts.ready,
                reused: state.job.counts.reused,
                random: state.job.counts.unclassified,
                failed: state.job.counts.failed,
                expired: state.job.counts.expired
              })}
            </p>
            {state.job.sourceKind === 'local' &&
              state.job.entries.some(entry => entry.state === 'waiting_source') && (
                <p className="team-inline-note">{t('catalogImagesReselect')}</p>
              )}
            <ul className="product-catalog-sources">
              {state.job.entries.slice(0, shownEntries).map(entry => (
                <li key={entry.id}>
                  <span className="product-catalog-source-name">{entry.displayName}</span>
                  <small>
                    {t(stageKeys[entry.state])} ·{' '}
                    {entry.classification.mode === 'matched'
                      ? `${entry.classification.garment} / ${entry.classification.color}`
                      : t('catalogImagesRandomMode')}
                  </small>
                </li>
              ))}
            </ul>
            {shownEntries < state.job.entries.length && (
              <Button
                type="button"
                variant="link"
                onClick={() => setShownEntries(count => count + 50)}
              >
                {t('catalogImagesShowMore')}
              </Button>
            )}
            {state.job.hasMore && (
              <Button type="button" variant="link" onClick={() => void state.moreEntries()}>
                {t('catalogImagesShowMore')}
              </Button>
            )}
            {state.capabilities?.canManage && (
              <div className="settings-section-actions">
                {!jobDone && (
                  <Button type="button" variant="secondary" onClick={() => void state.cancel()}>
                    {t('catalogImagesCancel')}
                  </Button>
                )}
                {(state.job.counts.failed > 0 ||
                  state.job.counts.expired > 0 ||
                  state.job.state === 'failed' ||
                  state.job.state === 'awaiting_reconciliation') && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={state.busy}
                    onClick={() => void state.retry()}
                  >
                    {t('catalogImagesRetry')}
                  </Button>
                )}
              </div>
            )}
          </section>
        )}
      </SettingsSection>
      {pickingFolder && folderClient && (
        <FolderPicker
          teamId={teamId}
          client={folderClient}
          title={t('catalogImagesChooseDrive')}
          nested
          selectionId="material"
          allowRoot={false}
          onClose={() => setPickingFolder(false)}
          onSelect={folder => {
            setPickingFolder(false);
            if (folder.id !== 'root') state.chooseFolder(folder);
          }}
        />
      )}
      {manualPrompt && (
        <Modal labelledBy={promptTitleId} nested size="lg" onClose={() => setManualPrompt(false)}>
          <h3 id={promptTitleId}>{t('catalogImagesCopyPrompt')}</h3>
          <Textarea
            aria-label={t('catalogImagesCopyPrompt')}
            readOnly
            rows={14}
            value={CATALOG_IMAGE_PROMPT}
            onFocus={event => event.currentTarget.select()}
          />
          <Button type="button" variant="secondary" onClick={() => setManualPrompt(false)}>
            {t('catalogImagesClose')}
          </Button>
        </Modal>
      )}
      {revoking && (
        <Modal labelledBy={revokeTitleId} nested size="sm" onClose={() => setRevoking(null)}>
          <h3 id={revokeTitleId}>{t('catalogImagesRevokePicture')}</h3>
          <p>{t('catalogImagesRevokeImpact')}</p>
          <Button
            type="button"
            variant="danger"
            disabled={state.busy}
            onClick={() => {
              void state.revokePicture(revoking);
              setRevoking(null);
            }}
          >
            {t('catalogImagesRevokePicture')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setRevoking(null)}>
            {t('catalogImagesClose')}
          </Button>
        </Modal>
      )}
    </>
  );
}
