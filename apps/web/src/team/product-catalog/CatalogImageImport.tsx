import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ExternalLink,
  Folder,
  Image,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import type {
  CatalogImageEntryState,
  CatalogImageImportState,
  CatalogImageDictionaryEntry,
  CatalogImageLibraryEntry
} from '@video-compressor/shared';
import type { CatalogImageClient } from '../../api/team-catalog-images';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  Button,
  Checkbox,
  DropdownMenu,
  IconButton,
  Input,
  Modal,
  Pagination,
  Progress,
  Textarea
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { teamErrorMessageFor } from '../errors';
import { SettingsSection } from '../workspace/SettingsSection';
import { CATALOG_IMAGE_PROMPT, recordCatalogImagePrompt } from './catalogImagePrompt';
import { useCatalogImageImport } from './useCatalogImageImport';
import './catalog-image-import.css';

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
  legacy,
  section: Section = SettingsSection,
  onBusyChange
}: {
  teamId: string;
  client: CatalogImageClient;
  folderClient?: FolderPickerClient;
  legacySources?: () => Promise<readonly string[]>;
  onPool: (count: number | null) => void;
  legacy?: ReactNode;
  section?: typeof SettingsSection;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t, language } = useI18n();
  const state = useCatalogImageImport(teamId, client);
  useEffect(() => {
    onBusyChange?.(state.busy);
  }, [state.busy, onBusyChange]);
  const [statusChecked, setStatusChecked] = useState(false);
  const checkStatus = async () => {
    setStatusChecked(false);
    if (await state.refresh()) setStatusChecked(true);
  };
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const promptTitleId = useId();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [over, setOver] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [manualPrompt, setManualPrompt] = useState(false);
  const [revoking, setRevoking] = useState<CatalogImageDictionaryEntry | null>(null);
  const [shownFiles, setShownFiles] = useState(10);
  const [shownEntries, setShownEntries] = useState(10);
  const [surface, setSurface] = useState<
    'upload' | 'help' | 'storage' | 'history' | 'status' | null
  >(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpFromUpload, setHelpFromUpload] = useState(false);
  const closeSurface = () => setSurface(surface === 'help' && helpFromUpload ? 'upload' : null);
  const [bulkConfirm, setBulkConfirm] = useState<{
    kind: 'remove' | 'revoke';
    entries: CatalogImageLibraryEntry[];
  } | null>(null);
  const openStorage = () => {
    setSurface('storage');
    if (!state.busy) void state.loadAllLibrary();
  };
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const sizeLabel = (bytes: number) => {
    const unit =
      bytes >= 1_000_000_000 ? 'GB' : bytes >= 1_000_000 ? 'MB' : bytes >= 1000 ? 'KB' : 'B';
    const divisor =
      unit === 'GB' ? 1_000_000_000 : unit === 'MB' ? 1_000_000 : unit === 'KB' ? 1000 : 1;
    return `${new Intl.NumberFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      maximumFractionDigits: 2
    }).format(bytes / divisor)} ${unit}`;
  };
  const [galleryQuery, setGalleryQuery] = useState('');
  const [galleryPage, setGalleryPage] = useState(1);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryPage, setLibraryPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 24;
  const GALLERY_PAGE_SIZE = 6;
  const imageLabel = (entry: CatalogImageDictionaryEntry) =>
    entry.classification.mode === 'matched'
      ? `${entry.classification.garment} / ${entry.classification.color}`
      : t('catalogImagesRandomMode');
  const matches = (entry: CatalogImageDictionaryEntry, query: string) =>
    imageLabel(entry).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const galleryFound = (state.dictionary?.items ?? []).filter(entry =>
    matches(entry, galleryQuery)
  );
  const libraryFound = (state.library?.items ?? []).filter(entry => matches(entry, libraryQuery));
  const galleryPages = Math.max(1, Math.ceil(galleryFound.length / GALLERY_PAGE_SIZE));
  const libraryPages = Math.max(1, Math.ceil(libraryFound.length / PAGE_SIZE));
  const visibleGalleryPage = Math.min(galleryPage, galleryPages);
  const visibleLibraryPage = Math.min(libraryPage, libraryPages);
  const galleryShown = galleryFound.slice(
    (visibleGalleryPage - 1) * GALLERY_PAGE_SIZE,
    visibleGalleryPage * GALLERY_PAGE_SIZE
  );
  const libraryShown = libraryFound.slice(
    (visibleLibraryPage - 1) * PAGE_SIZE,
    visibleLibraryPage * PAGE_SIZE
  );
  const selectable = (entry: CatalogImageLibraryEntry) =>
    entry.publicationState === 'ready' && !state.pendingRevocations.has(entry.publicationId);
  const toggleSelected = (id: string, checked: boolean) =>
    setSelected(previous => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectedEntries = (state.library?.items ?? []).filter(entry => selected.has(entry.id));
  const selectedBytes = selectedEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  useEffect(() => {
    setSelected(new Set());
    setGalleryQuery('');
    setLibraryQuery('');
    setGalleryPage(1);
    setLibraryPage(1);
  }, [teamId]);
  const copyFlow = useRef<string | null>(null);
  const enabled = Boolean(
    state.capabilities?.enabled && state.capabilities.importEnabled && state.capabilities.canManage
  );
  useEffect(() => {
    if (state.capabilities?.mode === 'v2')
      onPool(state.error !== null || !state.inventory ? null : state.inventory.total);
  }, [onPool, state.capabilities?.mode, state.inventory, state.error]);
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
  const uncertain =
    state.job?.state === 'awaiting_reconciliation' ||
    Boolean(state.imports?.items.some(item => item.state === 'awaiting_reconciliation'));
  const jobDone =
    state.job &&
    ['completed', 'partial', 'failed', 'cancelled', 'expired'].includes(state.job.state);
  const revocationLabel = t(
    revoking && 'publicationState' in revoking
      ? 'catalogImagesDeletePicture'
      : 'catalogImagesRevokePicture'
  );

  return (
    <>
      {state.capabilities?.mode === 'legacy' && legacy}
      <Section
        icon={Image}
        titleId="catalog-r2-images-title"
        title={t('catalogImagesTitle')}
        aside={
          state.inventory && state.error === null ? (
            <span className="catalog-image-aside">
              {t('productCatalogImagesPool', { count: state.inventory.total })}
              {state.storage && state.storageError === null && (
                <span>
                  {t('catalogImagesUsed', { size: sizeLabel(state.storage.usedBytes) })} ·{' '}
                  {t('catalogImagesFree', { size: sizeLabel(state.storage.availableBytes) })}
                </span>
              )}
              {state.storageError !== null && <span>{t('catalogImagesCapacityUnconfirmed')}</span>}
            </span>
          ) : undefined
        }
        className="product-catalog-pool"
      >
        <div className="catalog-image-content">
          <div className="catalog-image-storage-summary">
            {state.storage ? (
              <>
                <div className="catalog-image-storage-numbers">
                  <strong>
                    {t('catalogImagesUsed', { size: sizeLabel(state.storage.usedBytes) })}
                  </strong>
                  <span>
                    {t('catalogImagesFree', { size: sizeLabel(state.storage.availableBytes) })}
                  </span>
                </div>
                <Progress
                  value={
                    state.storage.limitBytes > 0
                      ? (state.storage.usedBytes / state.storage.limitBytes) * 100
                      : 100
                  }
                  color="secondary"
                  label={t('catalogImagesStorageHeading')}
                  valueText={t('catalogImagesStorageMeter', {
                    used: sizeLabel(state.storage.usedBytes),
                    free: sizeLabel(state.storage.availableBytes),
                    limit: sizeLabel(state.storage.limitBytes)
                  })}
                />

                <p className="field-hint">{t('catalogImagesOwnerLimit')}</p>
              </>
            ) : (
              <p role="status">
                {t(
                  state.storageError === null
                    ? 'catalogImagesStorageLoading'
                    : 'catalogImagesStorageUnavailable'
                )}
              </p>
            )}
          </div>
          <div className="catalog-image-toolbar">
            <span className="field-hint">{t('catalogImagesGalleryHint')}</span>
            <div className="catalog-image-actions">
              {state.capabilities?.canManage && (
                <Button variant="secondary" onClick={openStorage}>
                  <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                  {t('catalogImagesManage')}
                </Button>
              )}
              {enabled && (
                <Button
                  variant="primary"
                  disabled={state.busy}
                  onClick={() => setSurface('upload')}
                >
                  {t('catalogImagesAdd')}
                </Button>
              )}
              <span ref={menuAnchor}>
                <IconButton
                  label={t('catalogImagesActions')}
                  title=""
                  variant="ghost"
                  onClick={() => setMenuOpen(true)}
                >
                  <MoreHorizontal />
                </IconButton>
                <DropdownMenu
                  open={menuOpen}
                  onClose={() => setMenuOpen(false)}
                  anchor={menuAnchor}
                  label={t('catalogImagesActions')}
                  items={[
                    {
                      id: 'help',
                      label: t('catalogImagesHelpTitle'),
                      onSelect: () => {
                        setHelpFromUpload(false);
                        setSurface('help');
                      }
                    },
                    {
                      id: 'storage',
                      label: t('catalogImagesStorageHeading'),
                      onSelect: openStorage
                    },
                    {
                      id: 'history',
                      label: t('catalogImagesRecentImports'),
                      onSelect: () => setSurface('history')
                    },
                    {
                      id: 'refresh',
                      label: t('catalogImagesRefresh'),
                      disabled: state.loading || state.busy,
                      onSelect: () => void state.refresh()
                    }
                  ]}
                />
              </span>
            </div>
          </div>
          {state.loading && <p role="status">{t('catalogImagesLoading')}</p>}
          {state.capabilities && !state.capabilities.enabled && (
            <p className="team-inline-note">{t('catalogImagesSetupRequired')}</p>
          )}
          {state.capabilities?.enabled && !state.capabilities.importEnabled && (
            <p className="team-inline-note">{t('catalogImagesImportsPaused')}</p>
          )}
          {state.error !== null && (
            <div className="catalog-image-status" role="alert">
              <span>{teamErrorMessageFor(state.error, t)}</span>
              <Button
                variant="ghost"
                disabled={state.busy || state.loading}
                onClick={() => void checkStatus()}
              >
                {t('catalogImagesRefresh')}
              </Button>
            </div>
          )}
          {state.storageError !== null && (
            <div className="catalog-image-status" role="alert">
              <span>
                {t(state.storage ? 'catalogImagesStorageStale' : 'catalogImagesStorageUnavailable')}
              </span>
              <Button variant="ghost" onClick={openStorage}>
                {t('catalogImagesStorageHeading')}
              </Button>
            </div>
          )}
          {state.libraryError !== null && (
            <div className="catalog-image-status" role="alert">
              <span>{t('catalogImagesLibraryUnavailable')}</span>
              <Button variant="ghost" onClick={openStorage}>
                {t('catalogImagesStorageHeading')}
              </Button>
            </div>
          )}
          {state.storage &&
            (state.storage.usedBytes >= state.storage.limitBytes ||
              state.storage.totalImages >= state.storage.limitImages) && (
              <div className="catalog-image-status" role="status">
                <span>{t('catalogImagesCapacityFull')}</span>
                <Button variant="ghost" onClick={openStorage}>
                  {t('catalogImagesStorageHeading')}
                </Button>
              </div>
            )}
          {state.library?.items.some(entry => entry.publicationState === 'purge_unknown') && (
            <div className="catalog-image-status" role="status">
              <span>{t('catalogImagesLibraryUnknown')}</span>
              <Button
                variant="secondary"
                disabled={state.loading || state.refreshing}
                loading={state.refreshing}
                onClick={() => void checkStatus()}
              >
                {t('catalogImagesReconcile')}
              </Button>
            </div>
          )}
          {(state.pendingRevocations.size > 0 ||
            (state.storage?.pendingDeletionBytes ?? 0) > 0) && (
            <div className="catalog-image-status" role="status">
              <span>{t('catalogImagesLibraryDeleting')}</span>
              <Button variant="ghost" onClick={openStorage}>
                {t('catalogImagesDetails')}
              </Button>
            </div>
          )}
          {state.revocationRequested && (
            <p role="status" className="catalog-image-status">
              {t('catalogImagesRevocationQueued')}
            </p>
          )}
          {statusChecked && !state.refreshing && state.error === null && (
            <p className="field-hint" role="status">
              {t(uncertain ? 'catalogImagesStillUnconfirmed' : 'catalogImagesStatusUpdated')}
            </p>
          )}
          {state.imports?.items
            .filter(item => item.state === 'awaiting_reconciliation' && item.id !== state.job?.id)
            .map(item => (
              <div key={item.id} className="catalog-image-status" role="status">
                <span>
                  {t('catalogImagesStageUncertain')} · {item.counts.ready + item.counts.reused}/
                  {item.counts.total}
                </span>
                <Button
                  variant="secondary"
                  disabled={state.loading || state.refreshing}
                  loading={state.refreshing}
                  onClick={() => void checkStatus()}
                >
                  {t('catalogImagesReconcile')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => {
                    void state.selectJob(item.id);
                    setSurface('status');
                  }}
                >
                  {t('catalogImagesDetails')}
                </Button>
              </div>
            ))}
          {state.job && (
            <div className="catalog-image-status" role="status">
              <span>
                {t(stageKeys[state.job.state])} · {state.job.counts.ready + state.job.counts.reused}
                /{state.job.counts.total}
              </span>
              {state.job.state === 'awaiting_reconciliation' && (
                <Button
                  variant="secondary"
                  disabled={state.loading || state.refreshing}
                  loading={state.refreshing}
                  onClick={() => void checkStatus()}
                >
                  {t('catalogImagesReconcile')}
                </Button>
              )}
              {state.waitingUploads > 0 && <span>{t('catalogImagesWaitingCapacity')}</span>}
              {state.capabilities?.canManage &&
                state.job.state !== 'awaiting_reconciliation' &&
                (state.job.state === 'failed' ||
                  state.job.counts.failed > 0 ||
                  state.job.counts.expired > 0) && (
                  <Button
                    variant="secondary"
                    disabled={state.busy}
                    onClick={() => void state.retry()}
                  >
                    {t('catalogImagesRetry')}
                  </Button>
                )}
              <Button variant="ghost" onClick={() => setSurface('status')}>
                {t('catalogImagesDetails')}
              </Button>
            </div>
          )}
          {state.dictionary &&
            state.dictionary.items.length === 0 &&
            !state.loading &&
            state.error === null && (
              <div className="catalog-image-empty">
                <Image size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                <p>{t('catalogImagesGalleryEmpty')}</p>
                {enabled && (
                  <Button variant="secondary" onClick={() => setSurface('upload')}>
                    {t('catalogImagesChooseFiles')}
                  </Button>
                )}
              </div>
            )}
          {state.dictionary && state.dictionary.items.length > 0 && (
            <>
              <div className="catalog-image-search">
                <Input
                  aria-label={t('catalogImagesSearch')}
                  placeholder={t('catalogImagesSearch')}
                  value={galleryQuery}
                  onChange={event => {
                    setGalleryQuery(event.target.value);
                    setGalleryPage(1);
                  }}
                />
                {(galleryQuery.trim() || state.dictionary.hasMore) && (
                  <p className="field-hint">
                    {t('catalogImagesSearchCoverage', {
                      loaded: state.dictionary.items.length,
                      total: state.dictionary.total,
                      found: galleryFound.length
                    })}
                  </p>
                )}
              </div>
              <ul className="catalog-image-gallery">
                {galleryShown.map(entry => (
                  <GalleryPicture
                    key={entry.id}
                    entry={entry}
                    busy={state.busy || state.error !== null}
                    canManage={Boolean(state.capabilities?.canManage)}
                    onRemove={() => void state.removePicture(entry)}
                    onRevoke={() => setRevoking(entry)}
                  />
                ))}
              </ul>
              {galleryFound.length === 0 && <p>{t('catalogImagesNoMatches')}</p>}
              <Pagination
                className="catalog-image-pagination"
                page={visibleGalleryPage}
                pageCount={galleryPages}
                onChange={setGalleryPage}
                label={t('catalogImagesPages')}
                previousLabel={t('catalogImagesPrevious')}
                nextLabel={t('catalogImagesNext')}
              />
            </>
          )}
          {state.dictionary?.hasMore && (
            <Button
              variant="link"
              disabled={state.loading || state.refreshing}
              loading={state.refreshing}
              onClick={() => void state.morePictures()}
            >
              {t('catalogImagesLoadMore')}
            </Button>
          )}
        </div>
      </Section>
      {surface === 'upload' && (
        <Modal nested size="lg" title={t('catalogImagesAdd')} onClose={closeSurface}>
          <div className="catalog-image-dialog">
            <div className="catalog-image-dialog-close">
              <IconButton
                label={t('catalogImagesClose')}
                title=""
                variant="ghost"
                onClick={closeSurface}
              >
                <X />
              </IconButton>
            </div>
            <p className="team-inline-note prose">{t('catalogImagesPublicNotice')}</p>
            <p className="field-hint prose">{t('catalogImagesQuickFormats')}</p>
            {state.error !== null && (
              <p role="alert" className="team-inline-error">
                {teamErrorMessageFor(state.error, t)}
              </p>
            )}
            {uncertain && (
              <div className="catalog-image-status" role="status">
                <span>
                  {t(
                    statusChecked ? 'catalogImagesStillUnconfirmed' : 'catalogImagesStageUncertain'
                  )}
                </span>
                <Button
                  disabled={state.loading || state.refreshing}
                  loading={state.refreshing}
                  onClick={() => void checkStatus()}
                >
                  {t('catalogImagesReconcile')}
                </Button>
              </div>
            )}
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
                {state.folder && (
                  <p>{t('catalogImagesSelectedFolder', { name: state.folder.name })}</p>
                )}
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
                {state.waitingUploads > 0 && (
                  <p role="status">{t('catalogImagesWaitingCapacity')}</p>
                )}
              </>
            )}
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
            <Button
              variant="link"
              onClick={() => {
                setHelpFromUpload(true);
                setSurface('help');
              }}
            >
              {t('catalogImagesHelpTitle')}
            </Button>
          </div>
        </Modal>
      )}
      {surface === 'help' && (
        <Modal nested size="md" title={t('catalogImagesHelpTitle')} onClose={closeSurface}>
          <div className="catalog-image-dialog prose">
            <div className="catalog-image-dialog-close">
              <IconButton
                label={t('catalogImagesClose')}
                title=""
                variant="ghost"
                onClick={closeSurface}
              >
                <X />
              </IconButton>
            </div>
            {helpFromUpload && (
              <Button variant="link" onClick={() => setSurface('upload')}>
                {t('catalogImagesBackToUpload')}
              </Button>
            )}
            {state.inventory && (
              <p>
                {t('catalogImagesInventory', {
                  matched: state.inventory.total - state.inventory.unclassified,
                  random: state.inventory.unclassified
                })}
              </p>
            )}
            <p>{t('catalogImagesOptimizationNotice')}</p>
            <p>{t('catalogImagesFormatHint')}</p>
            <p>{t('catalogImagesRemoveHint')}</p>
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
          </div>
        </Modal>
      )}
      {surface === 'storage' && (
        <Modal nested size="lg" title={t('catalogImagesStorageHeading')} onClose={closeSurface}>
          <div className="catalog-image-dialog">
            <div className="catalog-image-dialog-close">
              <IconButton
                label={t('catalogImagesRefresh')}
                title={t('catalogImagesRefresh')}
                variant="ghost"
                disabled={state.loading || state.busy || state.libraryLoading}
                onClick={() => void checkStatus()}
              >
                <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} />
              </IconButton>
              <IconButton
                label={t('catalogImagesClose')}
                title=""
                variant="ghost"
                onClick={closeSurface}
              >
                <X />
              </IconButton>
            </div>
            {state.capabilities && (
              <section
                className="catalog-image-manager-summary"
                aria-label={t('catalogImagesStorageHeading')}
              >
                {state.storage ? (
                  <>
                    <p className="catalog-image-manager-capacity" role="status">
                      {t('catalogImagesStorageMeter', {
                        used: sizeLabel(state.storage.usedBytes),
                        free: sizeLabel(state.storage.availableBytes),
                        limit: sizeLabel(state.storage.limitBytes)
                      })}
                    </p>
                    <p className="field-hint">
                      {t('catalogImagesOwnerLimit')} · {state.storage.totalImages}/
                      {state.storage.limitImages}
                    </p>
                    {(state.storage.reservedBytes > 0 ||
                      state.storage.pendingDeletionBytes > 0 ||
                      state.storage.retainedBytes > 0) && (
                      <p className="field-hint">
                        {t('catalogImagesStorageBreakdown', {
                          processing: sizeLabel(state.storage.reservedBytes),
                          deleting: sizeLabel(state.storage.pendingDeletionBytes),
                          retained: sizeLabel(state.storage.retainedBytes)
                        })}
                      </p>
                    )}
                    {state.storage.otherTeamBytes > 0 && (
                      <p className="field-hint">
                        {t('catalogImagesStorageSpaces', {
                          team: sizeLabel(state.storage.teamBytes),
                          other: sizeLabel(state.storage.otherTeamBytes)
                        })}
                      </p>
                    )}
                    {(state.storage.usedBytes >= state.storage.limitBytes ||
                      state.storage.totalImages >= state.storage.limitImages) && (
                      <p className="team-inline-note">{t('catalogImagesCapacityFull')}</p>
                    )}
                  </>
                ) : state.storageError === null ? (
                  <p role="status">{t('catalogImagesStorageLoading')}</p>
                ) : null}
                {state.storageError !== null && (
                  <p role="alert" className="team-inline-error">
                    {t(
                      state.storage
                        ? 'catalogImagesStorageStale'
                        : 'catalogImagesStorageUnavailable'
                    )}
                  </p>
                )}
              </section>
            )}
            {state.capabilities?.canManage && (
              <section aria-label={t('catalogImagesLibraryHeading')}>
                <p className="field-hint">{t('catalogImagesManagerHint')}</p>
                {state.libraryError !== null && (
                  <p role="alert" className="team-inline-error">
                    {t('catalogImagesLibraryUnavailable')}
                  </p>
                )}
                {!state.library && state.libraryError === null && (
                  <p role="status">{t('catalogImagesLoading')}</p>
                )}
                {state.library?.items.length === 0 && <p>{t('catalogImagesLibraryEmpty')}</p>}
                {state.library && (
                  <>
                    {state.libraryLoading ? (
                      <p role="status">
                        {t('catalogImagesLoadingLibrary', {
                          loaded: state.library.items.length,
                          total: state.library.total
                        })}
                      </p>
                    ) : !state.library.hasMore &&
                      state.library.items.length === state.library.total &&
                      state.libraryError === null ? (
                      <p className="field-hint">
                        {t('catalogImagesSearchComplete', { count: state.library.items.length })}
                      </p>
                    ) : null}
                    {!state.libraryLoading &&
                      !state.library.hasMore &&
                      state.library.items.length !== state.library.total && (
                        <p role="status">{t('catalogImagesLibraryIncomplete')}</p>
                      )}
                    <div className="catalog-image-search">
                      <Input
                        aria-label={t('catalogImagesSearchStored')}
                        placeholder={t('catalogImagesSearch')}
                        value={libraryQuery}
                        onChange={event => {
                          setLibraryQuery(event.target.value);
                          setLibraryPage(1);
                        }}
                      />
                      {(libraryQuery.trim() !== '' ||
                        state.library.hasMore ||
                        state.library.items.length !== state.library.total) && (
                        <p className="field-hint">
                          {t('catalogImagesSearchCoverage', {
                            loaded: state.library.items.length,
                            total: state.library.total,
                            found: libraryFound.length
                          })}
                        </p>
                      )}
                    </div>
                    <div className="catalog-image-select-toolbar">
                      <Checkbox
                        label={t('catalogImagesSelectShown', {
                          count: libraryShown.filter(selectable).length
                        })}
                        checked={
                          libraryShown.filter(selectable).length > 0 &&
                          libraryShown.filter(selectable).every(entry => selected.has(entry.id))
                        }
                        disabled={
                          state.busy ||
                          state.libraryError !== null ||
                          libraryShown.filter(selectable).length === 0
                        }
                        onChange={checked =>
                          setSelected(previous => {
                            const next = new Set(previous);
                            for (const entry of libraryShown.filter(selectable)) {
                              if (checked) next.add(entry.id);
                              else next.delete(entry.id);
                            }
                            return next;
                          })
                        }
                      />
                      {selected.size > 0 && (
                        <Button
                          variant="ghost"
                          disabled={state.busy}
                          onClick={() => setSelected(new Set())}
                        >
                          {t('catalogImagesClearSelection')}
                        </Button>
                      )}
                    </div>
                    {!state.library.hasMore &&
                      state.library.items.length === state.library.total &&
                      !state.libraryLoading &&
                      state.libraryError === null &&
                      libraryFound.filter(selectable).length >
                        libraryShown.filter(selectable).length && (
                        <Button
                          variant="ghost"
                          disabled={state.busy}
                          onClick={() =>
                            setSelected(
                              previous =>
                                new Set([
                                  ...previous,
                                  ...libraryFound.filter(selectable).map(entry => entry.id)
                                ])
                            )
                          }
                        >
                          {t('catalogImagesSelectAllMatches', {
                            count: libraryFound.filter(selectable).length
                          })}
                        </Button>
                      )}
                    {selectedEntries.length > 0 && (
                      <div
                        className="catalog-image-selection"
                        role="region"
                        aria-label={t('catalogImagesManage')}
                      >
                        <strong>
                          {t('catalogImagesSelected', {
                            count: selectedEntries.length,
                            size: sizeLabel(selectedBytes)
                          })}
                        </strong>
                        <div className="catalog-image-selection-actions">
                          <Button
                            variant="secondary"
                            disabled={
                              state.busy ||
                              state.libraryLoading ||
                              state.libraryError !== null ||
                              !selectedEntries.some(entry => entry.active && selectable(entry))
                            }
                            onClick={() =>
                              setBulkConfirm({
                                kind: 'remove',
                                entries: selectedEntries.filter(
                                  entry => entry.active && selectable(entry)
                                )
                              })
                            }
                          >
                            {t('catalogImagesRemoveSelected')}
                          </Button>
                          <Button
                            color="error"
                            variant="outline"
                            disabled={
                              state.busy ||
                              state.libraryLoading ||
                              state.libraryError !== null ||
                              selectedEntries.some(entry => !selectable(entry))
                            }
                            onClick={() =>
                              setBulkConfirm({ kind: 'revoke', entries: selectedEntries })
                            }
                          >
                            {t('catalogImagesDeleteSelected', { count: selectedEntries.length })}
                          </Button>
                        </div>
                      </div>
                    )}
                    {state.bulkProgress && (
                      <p role="status">{t('catalogImagesBulkProgress', state.bulkProgress)}</p>
                    )}
                    {state.bulkResult && (
                      <div className="catalog-image-status" role="status">
                        <p>{t('catalogImagesBulkResult', state.bulkResult)}</p>
                        {state.bulkResult.failed > 0 && <p>{t('catalogImagesBulkStopped')}</p>}
                        <Button
                          variant="ghost"
                          disabled={state.busy || state.libraryLoading}
                          onClick={() => {
                            void state.refresh();
                          }}
                        >
                          {t('catalogImagesReconcile')}
                        </Button>
                      </div>
                    )}
                    <ul className="catalog-image-library-list">
                      {libraryShown.map(entry => {
                        const pending =
                          entry.publicationState !== 'ready' ||
                          state.pendingRevocations.has(entry.publicationId);
                        return (
                          <li key={entry.id} className="catalog-image-library-row">
                            <Checkbox
                              aria-label={t('catalogImagesSelectImage', {
                                name: imageLabel(entry)
                              })}
                              checked={selected.has(entry.id)}
                              disabled={state.busy || pending || state.libraryError !== null}
                              onChange={checked => toggleSelected(entry.id, checked)}
                            />
                            {!pending && (
                              <span className="catalog-image-library-thumb">
                                <img
                                  src={entry.publicUrl}
                                  alt={
                                    entry.classification.mode === 'matched'
                                      ? `${entry.classification.garment} / ${entry.classification.color}`
                                      : t('catalogImagesRandomMode')
                                  }
                                  loading="lazy"
                                  decoding="async"
                                  referrerPolicy="no-referrer"
                                />
                              </span>
                            )}
                            <div className="catalog-image-library-info">
                              <span className="catalog-image-library-name">
                                {entry.classification.mode === 'matched'
                                  ? `${entry.classification.garment} / ${entry.classification.color}`
                                  : t('catalogImagesRandomMode')}
                              </span>
                              <div className="catalog-image-library-meta">
                                <small>{sizeLabel(entry.sizeBytes)}</small>
                                <small>
                                  {t(
                                    entry.active
                                      ? 'catalogImagesLibraryActive'
                                      : 'catalogImagesLibraryRetained'
                                  )}
                                </small>
                                {entry.inUse && <small>{t('catalogImagesLibraryInUse')}</small>}
                              </div>
                              {pending ? (
                                <small role="status">
                                  {t(
                                    entry.publicationState === 'purge_unknown'
                                      ? 'catalogImagesLibraryUnknown'
                                      : 'catalogImagesLibraryDeleting'
                                  )}
                                </small>
                              ) : (
                                <div className="catalog-image-library-actions">
                                  <a
                                    className="catalog-image-open"
                                    href={entry.publicUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t('catalogImagesOpenPicture')}
                                    title={t('catalogImagesOpenPicture')}
                                  >
                                    <ExternalLink
                                      size={ICON_SIZE}
                                      strokeWidth={ICON_STROKE}
                                      aria-hidden="true"
                                    />
                                  </a>
                                  <IconButton
                                    label={t('catalogImagesDeletePicture')}
                                    title={t('catalogImagesDeletePicture')}
                                    variant="ghost"
                                    disabled={state.busy || state.libraryError !== null}
                                    onClick={() => setRevoking(entry)}
                                  >
                                    <Trash2
                                      size={ICON_SIZE}
                                      strokeWidth={ICON_STROKE}
                                      aria-hidden="true"
                                    />
                                  </IconButton>
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {libraryFound.length === 0 && <p>{t('catalogImagesNoMatches')}</p>}
                    <Pagination
                      className="catalog-image-pagination"
                      page={visibleLibraryPage}
                      pageCount={libraryPages}
                      onChange={setLibraryPage}
                      label={t('catalogImagesPages')}
                      previousLabel={t('catalogImagesPrevious')}
                      nextLabel={t('catalogImagesNext')}
                    />
                  </>
                )}
                {state.library?.hasMore && (
                  <Button
                    type="button"
                    variant="link"
                    disabled={state.libraryLoading || state.busy}
                    onClick={() => void state.moreLibrary()}
                  >
                    {t('catalogImagesLoadMore')}
                  </Button>
                )}
              </section>
            )}
          </div>
        </Modal>
      )}
      {surface === 'history' && (
        <Modal nested size="md" title={t('catalogImagesRecentImports')} onClose={closeSurface}>
          <div className="catalog-image-dialog">
            <div className="catalog-image-dialog-close">
              <IconButton
                label={t('catalogImagesClose')}
                title=""
                variant="ghost"
                onClick={closeSurface}
              >
                <X />
              </IconButton>
            </div>{' '}
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
                      onClick={() => {
                        void state.selectJob(item.id);
                        setSurface('status');
                      }}
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
            {state.imports?.items.length === 0 && <p>{t('catalogImagesHistoryEmpty')}</p>}
          </div>
        </Modal>
      )}
      {surface === 'status' && (
        <Modal nested size="lg" title={t('catalogImagesImportStatus')} onClose={closeSurface}>
          <div className="catalog-image-dialog">
            <div className="catalog-image-dialog-close">
              <IconButton
                label={t('catalogImagesClose')}
                title=""
                variant="ghost"
                onClick={closeSurface}
              >
                <X />
              </IconButton>
            </div>{' '}
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
                    <>
                      <p className="team-inline-note">{t('catalogImagesReselect')}</p>
                      <Button onClick={() => setSurface('upload')}>
                        {t('catalogImagesChooseFiles')}
                      </Button>
                    </>
                  )}
                <ul className="catalog-image-job-list">
                  {state.job.entries.slice(0, shownEntries).map(entry => (
                    <li key={entry.id}>
                      <span className="catalog-image-job-name">{entry.displayName}</span>
                      <small>
                        {t(stageKeys[entry.state])} ·{' '}
                        {entry.classification.mode === 'matched'
                          ? `${entry.classification.garment} / ${entry.classification.color}`
                          : t('catalogImagesRandomMode')}
                      </small>
                      {entry.errorCode && (
                        <p role="alert" className="team-inline-error">
                          {teamErrorMessageFor({ code: entry.errorCode }, t)}
                        </p>
                      )}
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
                        onClick={() =>
                          void (state.job?.state === 'awaiting_reconciliation'
                            ? state.refresh()
                            : state.retry())
                        }
                      >
                        {t(
                          state.job.state === 'awaiting_reconciliation'
                            ? 'catalogImagesReconcile'
                            : 'catalogImagesRetry'
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        </Modal>
      )}
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
      {bulkConfirm && (
        <Modal
          nested
          size="md"
          title={t(
            bulkConfirm.kind === 'remove'
              ? 'catalogImagesBulkRemoveTitle'
              : 'catalogImagesBulkDeleteTitle',
            { count: bulkConfirm.entries.length }
          )}
          busy={state.busy}
          onClose={() => {
            if (!state.busy) setBulkConfirm(null);
          }}
        >
          <div className="catalog-image-dialog">
            {state.bulkProgress && (
              <>
                <p role="status">{t('catalogImagesBulkProgress', state.bulkProgress)}</p>
                <Progress
                  label={t('catalogImagesManage')}
                  value={
                    state.bulkProgress.total > 0
                      ? (state.bulkProgress.done / state.bulkProgress.total) * 100
                      : 0
                  }
                />
              </>
            )}
            <p className="catalog-image-confirm-summary">
              {t('catalogImagesSelectionSize', {
                count: bulkConfirm.entries.length,
                size: sizeLabel(
                  bulkConfirm.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
                )
              })}
            </p>
            {bulkConfirm.kind === 'remove' ? (
              <p className="field-hint">{t('catalogImagesBulkRemoveBody')}</p>
            ) : (
              <>
                {bulkConfirm.entries.some(entry => entry.inUse) && (
                  <div className="catalog-image-confirm-warning">
                    <strong>
                      {t('catalogImagesSelectedInUse', {
                        count: bulkConfirm.entries.filter(entry => entry.inUse).length
                      })}
                    </strong>
                    <p>{t('catalogImagesDeleteLinksWarning')}</p>
                  </div>
                )}
                <p className="field-hint">{t('catalogImagesDeleteSpaceHint')}</p>
              </>
            )}
            <div className="settings-section-actions">
              <Button variant="ghost" disabled={state.busy} onClick={() => setBulkConfirm(null)}>
                {t('catalogImagesCancelAction')}
              </Button>
              <Button
                color={bulkConfirm.kind === 'revoke' ? 'error' : 'success'}
                loading={state.busy}
                onClick={async () => {
                  const action = bulkConfirm;
                  await state.batchChangePictures(action.entries, action.kind);
                  setBulkConfirm(null);
                  setSelected(new Set());
                }}
              >
                {t(
                  bulkConfirm.kind === 'remove'
                    ? 'catalogImagesRemoveConfirm'
                    : 'catalogImagesDeleteConfirm'
                )}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {revoking && (
        <Modal title={revocationLabel} nested size="sm" onClose={() => setRevoking(null)}>
          <div className="catalog-image-dialog">
            <p>{t('catalogImagesRevokeImpact')}</p>
            <p className="field-hint">{t('catalogImagesCleanupCapacity')}</p>
            <div className="settings-section-actions">
              <Button type="button" variant="ghost" onClick={() => setRevoking(null)}>
                {t('catalogImagesClose')}
              </Button>
              <Button
                type="button"
                color="error"
                disabled={state.busy}
                onClick={() => {
                  void state.revokePicture(revoking);
                  setRevoking(null);
                }}
              >
                {revocationLabel}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function GalleryPicture({
  entry,
  busy,
  canManage,
  onRemove,
  onRevoke
}: {
  entry: CatalogImageDictionaryEntry;
  busy: boolean;
  canManage: boolean;
  onRemove: () => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const label =
    entry.classification.mode === 'matched'
      ? `${entry.classification.garment} / ${entry.classification.color}`
      : t('catalogImagesRandomMode');
  return (
    <li className="catalog-image-tile">
      <a
        className="catalog-image-preview"
        href={entry.publicUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${t('catalogImagesOpenPicture')}: ${label}`}
      >
        <img
          src={entry.publicUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      </a>
      <div className="catalog-image-caption">
        <span>{label}</span>
        {canManage && (
          <span ref={anchor}>
            <IconButton
              title=""
              label={`${t('catalogImagesActions')}: ${label}`}
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              <MoreHorizontal />
            </IconButton>
            <DropdownMenu
              open={open}
              onClose={() => setOpen(false)}
              anchor={anchor}
              label={label}
              items={[
                {
                  id: 'remove',
                  label: t('catalogImagesRemovePicture'),
                  disabled: busy,
                  onSelect: onRemove
                },
                {
                  id: 'revoke',
                  label: t('catalogImagesRevokePicture'),
                  disabled: busy,
                  onSelect: onRevoke
                }
              ]}
            />
          </span>
        )}
      </div>
    </li>
  );
}
