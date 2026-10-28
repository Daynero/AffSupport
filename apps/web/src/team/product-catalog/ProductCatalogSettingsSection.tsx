import { createContext, useContext, useEffect, useId, useState, type ComponentProps } from 'react';
import { DollarSign, FileSpreadsheet, Folder, Image, Search, Sparkles, X } from 'lucide-react';
import type {
  ProductCatalogImageSource,
  ProductCatalogSettings,
  ProductCatalogText,
  ProductCatalogTextSchedule,
  TeamMaterialSummary
} from '../../api/team';
import {
  Accordion,
  Button,
  ErrorState,
  IconButton,
  Input,
  LoadingState,
  Modal,
  Switch,
  Textarea
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { useCatalogSettingsFlow } from './useCatalogSettingsFlow';
import './catalog-text-schedule.css';
import './catalog-settings-layout.css';
import { SettingsSection } from '../workspace/SettingsSection';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import type { CatalogImageClient } from '../../api/team-catalog-images';
import { CatalogImageImport } from './CatalogImageImport';
import {
  TaskAttachmentPicker,
  type TaskAttachmentPickerClient
} from '../tasks/TaskAttachmentPicker';
import {
  APPAREL_POOL_DEFAULT,
  APPAREL_POOL_MAX,
  clothesInPictures,
  generateApparelTexts
} from './apparelTexts';
import {
  DESCRIPTION_MAX,
  IMAGE_LINK_MAX,
  TITLE_MAX,
  validatePrice,
  validateWebLink
} from './limits';

export type { ProductCatalogTextSchedule } from '../../api/team';

export interface ProductCatalogSettingsClient {
  getProductCatalogTextSchedule?: (teamId: string) => Promise<ProductCatalogTextSchedule>;
  setProductCatalogTextSchedule?: (
    teamId: string,
    input: { enabled: boolean; count: number }
  ) => Promise<ProductCatalogTextSchedule>;
  catalogImages?: CatalogImageClient;
  getProductCatalogSettings: (teamId: string) => Promise<ProductCatalogSettings | null>;
  setProductCatalogSettings: (
    teamId: string,
    input: {
      title: string | null;
      description: string | null;
      priceMin: number;
      priceMax: number;
      imageLink: string | null;
    }
  ) => Promise<ProductCatalogSettings>;
  listProductCatalogImageSources?: (
    teamId: string
  ) => Promise<{ sources: ProductCatalogImageSource[]; poolSize: number }>;
  setProductCatalogImageSources?: (
    teamId: string,
    sources: ReadonlyArray<{ materialId: string; kind: 'file' | 'folder' }>
  ) => Promise<void>;
  listProductCatalogTexts?: (teamId: string) => Promise<ProductCatalogText[]>;
  replaceProductCatalogTexts?: (
    teamId: string,
    texts: ReadonlyArray<{ title: string; description: string }>
  ) => Promise<number>;
  updateProductCatalogText?: (
    teamId: string,
    text: ProductCatalogText
  ) => Promise<ProductCatalogText>;
  /** The names of the space's pictures, so the generator writes about what they show (US27). */
  listProductCatalogPoolNames?: (teamId: string) => Promise<string[]>;
}

const EditorContext = createContext({ open: '', toggle: (_id: string) => {} });
function CatalogSection({
  titleId,
  title,
  icon: Icon,
  aside,
  description,
  children,
  className
}: ComponentProps<typeof SettingsSection>) {
  const { open, toggle } = useContext(EditorContext);
  return (
    <Accordion
      className={['catalog-settings-editor', className].filter(Boolean).join(' ')}
      openIds={new Set([open])}
      onToggle={toggle}
      items={[
        {
          id: titleId,
          title,
          icon: <Icon size={20} strokeWidth={ICON_STROKE} />,
          aside,
          content: (
            <>
              {description && <p className="field-hint prose">{description}</p>}
              {children}
            </>
          )
        }
      ]}
    />
  );
}

export const PRICE_RANGE_DEFAULT = { min: 9, max: 30 } as const;

/**
 * What a space's catalogs are filled from (022, 024).
 *
 * Each part answers one question — which names, which pictures, what price — and the line above
 * them answers the one question the parts do not: whether a catalog can be made at all. That used
 * to be learned by making one and reading `settings_missing` in a toast.
 *
 * The single name, description and picture link every row used to share are a fallback now, in a
 * section of their own at the end, folded away: they matter only where a pool is empty.
 */
export function ProductCatalogSettingsSection({
  teamId,
  client,
  onDraftChange,
  openEditor,
  onOpenEditorChange,
  onBeforeLeave
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
  onBeforeLeave?: () => boolean;
  openEditor?: string;
  onOpenEditorChange?: (id: string) => void;
  onDraftChange?: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const [localOpen, setLocalOpen] = useState('');
  const open = openEditor ?? localOpen;
  const setOpen = (id: string) => {
    setLocalOpen(id);
    onOpenEditorChange?.(id);
  };
  const [valueDraft, setValueDraft] = useState({ dirty: false, saving: false });
  const [scheduleDraft, setScheduleDraft] = useState({ dirty: false, saving: false });
  const [imagesBusy, setImagesBusy] = useState(false);
  const [textsBusy, setTextsBusy] = useState(false);
  const saving = valueDraft.saving || scheduleDraft.saving || imagesBusy || textsBusy;
  useEffect(() => {
    onDraftChange?.({ dirty: valueDraft.dirty || scheduleDraft.dirty, saving });
  }, [onDraftChange, valueDraft.dirty, scheduleDraft.dirty, saving]);
  useEffect(
    () => () => {
      onDraftChange?.({ dirty: false, saving: false });
    },
    [onDraftChange]
  );
  useEffect(() => {
    if (!saving) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [saving]);
  const [images, setImages] = useState<number | null>(null);
  const [texts, setTexts] = useState<number | null>(null);
  const [fallback, setFallback] = useState<{ title: boolean; image: boolean } | null>(null);
  const [range, setRange] = useState<{ min: number; max: number } | null>(null);
  return (
    <EditorContext.Provider value={{ open, toggle: id => setOpen(open === id ? '' : id) }}>
      <div className="catalog-settings-overview">
        <CatalogSummarySection
          onBeforeLeave={onBeforeLeave}
          images={images}
          texts={texts}
          fallback={fallback}
          range={range}
          hasImageSources={Boolean(client.listProductCatalogImageSources || client.catalogImages)}
          hasTextPool={Boolean(client.listProductCatalogTexts)}
        />
        <CatalogImagesSection
          teamId={teamId}
          client={client}
          onPool={setImages}
          onBusyChange={setImagesBusy}
        />
        <CatalogTextsSection
          teamId={teamId}
          client={client}
          onCount={setTexts}
          onBusyChange={setTextsBusy}
          onScheduleDraftChange={setScheduleDraft}
        />
        <CatalogValuesSection
          teamId={teamId}
          client={client}
          onDraftChange={setValueDraft}
          onRange={setRange}
          onFallback={setFallback}
          hasImages={images === null ? null : images > 0}
          hasTexts={texts === null ? null : texts > 0}
        />
      </div>
    </EditorContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Whether a catalog can be made
// ---------------------------------------------------------------------------------------------

/** One line per column of the sheet: what it draws from, and whether it has anything to draw. */
function CatalogSummarySection({
  images,
  texts,
  fallback,
  range,
  hasImageSources,
  hasTextPool,
  onBeforeLeave
}: {
  onBeforeLeave?: () => boolean;
  images: number | null;
  texts: number | null;
  fallback: { title: boolean; image: boolean } | null;
  range: { min: number; max: number } | null;
  hasImageSources: boolean;
  hasTextPool: boolean;
}) {
  const { t } = useI18n();
  const known =
    fallback !== null && (!hasTextPool || texts !== null) && (!hasImageSources || images !== null);
  const ready =
    known &&
    ((texts ?? 0) > 0 || fallback?.title) &&
    ((images ?? 0) > 0 || fallback?.image) &&
    range !== null;
  return (
    <header className="catalog-settings-heading">
      <h2>{t('productCatalogSummaryTitle')}</h2>
      <p className="field-hint" role="status">
        {t(
          !known
            ? 'catalogSettingsUnknown'
            : ready
              ? 'productCatalogSummaryReady'
              : 'productCatalogSummaryBlocked'
        )}
      </p>
      {known && ((!(texts ?? 0) && fallback?.title) || (!(images ?? 0) && fallback?.image)) && (
        <p className="field-hint">{t('productCatalogFallbackInUse')}</p>
      )}
      <a
        className="product-catalog-updater-link"
        href={updaterHref()}
        onClick={event => {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          if (!onBeforeLeave || onBeforeLeave()) navigateTo(updaterHref());
        }}
      >
        {t('productCatalogUpdaterLink')}
      </a>
    </header>
  );
}

/** The updater, over the space the settings belong to: same address, one flag more. */
function updaterHref(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('settings');
  params.delete('tab');
  params.set('updater', '1');
  return `${window.location.pathname}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------

function CatalogImagesSection({
  teamId,
  client,
  onPool,
  onBusyChange
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
  onBusyChange: (busy: boolean) => void;
  onPool: (count: number | null) => void;
}) {
  if (!client.catalogImages)
    return (
      <LegacyCatalogImagesSection
        teamId={teamId}
        client={client}
        onPool={onPool}
        onBusyChange={onBusyChange}
      />
    );
  return (
    <CatalogImageImport
      teamId={teamId}
      client={client.catalogImages}
      section={CatalogSection}
      onBusyChange={onBusyChange}
      onPool={onPool}
      folderClient={client.listMaterials ? { listMaterials: client.listMaterials } : undefined}
      legacySources={
        client.listProductCatalogImageSources
          ? async () =>
              (await client.listProductCatalogImageSources!(teamId)).sources.map(
                source => source.materialId
              )
          : undefined
      }
      legacy={
        <LegacyCatalogImagesSection
          teamId={teamId}
          client={client}
          onPool={onPool}
          onBusyChange={onBusyChange}
        />
      }
    />
  );
}

function LegacyCatalogImagesSection({
  teamId,
  client,
  onPool,
  onBusyChange
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
  onBusyChange: (busy: boolean) => void;
  onPool: (count: number | null) => void;
}) {
  const { t } = useI18n();
  const diagnostic = useCatalogSettingsFlow();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const [sources, setSources] = useState<ProductCatalogImageSource[] | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    onBusyChange(saving);
  }, [saving, onBusyChange]);
  const [pickingFolder, setPickingFolder] = useState(false);

  const load = async (existingAttempt?: string) => {
    if (!client.listProductCatalogImageSources) return;
    setReadError(null);
    const attempt = existingAttempt ?? diagnostic.start();
    diagnostic.stage('readback_requested', attempt);
    try {
      const found = await client.listProductCatalogImageSources(teamId);
      setSources(found.sources);
      setPoolSize(found.poolSize);
      onPool(found.poolSize);
      diagnostic.confirm(attempt);
    } catch (error) {
      setReadError(teamErrorMessageFor(error, t));
      onPool(null);
      diagnostic.fail('READ_FAILED', attempt);
      throw error;
    }
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, [teamId]);

  const save = async (next: ReadonlyArray<{ materialId: string; kind: 'file' | 'folder' }>) => {
    if (!client.setProductCatalogImageSources || saving || readError || !sources) return;
    setSaving(true);
    const attempt = diagnostic.start();
    diagnostic.stage('save_requested');
    try {
      await client.setProductCatalogImageSources(teamId, next);
      diagnostic.stage('save_confirmed');
      await load(attempt);
      push({ tone: 'success', text: t('productCatalogSettingsSaved') });
    } catch (error) {
      setReadError(teamErrorMessageFor(error, t));
      onPool(null);
      diagnostic.fail('SAVE_FAILED');
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const current = (sources ?? []).map(source => ({
    materialId: source.materialId,
    kind: source.kind
  }));

  if (!client.listProductCatalogImageSources) return null;

  return (
    <CatalogSection
      icon={Image}
      titleId="product-catalog-images-title"
      title={t('productCatalogImagesTitle')}
      description={t('productCatalogImagesDescription')}
      aside={
        readError
          ? t('catalogSettingsReadFailed')
          : sources
            ? t('productCatalogImagesPool', { count: poolSize })
            : t('catalogSettingsLoading')
      }
      className="product-catalog-pool"
    >
      {readError && (
        <ErrorState
          retryLabel={t('catalogUpdaterRetry')}
          message={readError}
          onRetry={() => void load().catch(() => undefined)}
        />
      )}
      {!sources && !readError && <LoadingState count={1} label={t('catalogSettingsLoading')} />}
      {sources && sources.length > 0 && (
        <ul className="product-catalog-sources">
          {sources.map(source => (
            <li key={source.materialId}>
              {source.kind === 'folder' ? (
                <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <Image size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
              <span className="product-catalog-source-name" title={source.name}>
                {source.name}
              </span>
              {source.kind === 'folder' && (
                <small>{t('productCatalogImagesInFolder', { count: source.imageCount })}</small>
              )}
              {editable && (
                <IconButton
                  title=""
                  size="xs"
                  variant="ghost"
                  disabled={saving || Boolean(readError)}
                  label={t('productCatalogImagesRemove', { name: source.name })}
                  onClick={() =>
                    void save(current.filter(item => item.materialId !== source.materialId))
                  }
                >
                  <X aria-hidden="true" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {sources && sources.length === 0 && (
        <p className="team-inline-note">{t('productCatalogImagesEmpty')}</p>
      )}
      {editable &&
        sources &&
        !readError &&
        client.listMaterials &&
        client.attachTaskMaterials !== undefined && (
          <div className="settings-section-actions">
            <TaskAttachmentPicker
              teamId={teamId}
              client={client as TaskAttachmentPickerClient}
              /* Files only: a chosen folder stays open to browse, so single images inside it can be
               picked too. */
              attachedMaterialIds={
                new Set(current.filter(item => item.kind === 'file').map(item => item.materialId))
              }
              accept={(material: TeamMaterialSummary) => material.category === 'image'}
              title={t('productCatalogImagesPickTitle')}
              confirmLabel={count => t('productCatalogImagesPickConfirm', { count })}
              trigger={open => (
                <Button type="button" variant="secondary" disabled={saving} onClick={open}>
                  <Image size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t('productCatalogImagesAddFiles')}
                </Button>
              )}
              onAdd={picked =>
                void save([
                  ...current,
                  ...picked.map(item => ({ materialId: item.id, kind: 'file' as const }))
                ])
              }
            />
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setPickingFolder(true)}
            >
              <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('productCatalogImagesAddFolder')}
            </Button>
          </div>
        )}
      {pickingFolder && client.listMaterials && (
        <FolderPicker
          teamId={teamId}
          client={client as FolderPickerClient}
          title={t('productCatalogImagesPickFolder')}
          nested
          selectionId="material"
          onClose={() => setPickingFolder(false)}
          onSelect={folder => {
            setPickingFolder(false);
            if (folder.id === 'root') {
              push({ tone: 'error', text: t('productCatalogImagesRootRefused') });
              return;
            }
            void save([...current, { materialId: folder.id, kind: 'folder' }]);
          }}
        />
      )}
    </CatalogSection>
  );
}

// ---------------------------------------------------------------------------------------------
// Names and descriptions
// ---------------------------------------------------------------------------------------------

/** A sample in the tab, a page at a time in the browser. */
const TEXTS_PAGE = 50;

function CatalogTextsSection({
  teamId,
  client,
  onCount,
  onBusyChange,
  onScheduleDraftChange
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
  onBusyChange: (busy: boolean) => void;
  onScheduleDraftChange: (state: { dirty: boolean; saving: boolean }) => void;
  onCount: (count: number | null) => void;
}) {
  const { t } = useI18n();
  const diagnostic = useCatalogSettingsFlow();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const countId = useId();
  const [texts, setTexts] = useState<ProductCatalogText[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [count, setCount] = useState(String(APPAREL_POOL_DEFAULT));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const [confirming, setConfirming] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProductCatalogText | null>(null);

  useEffect(() => {
    if (!client.listProductCatalogTexts) return;
    let active = true;
    setReadError(null);
    const attempt = diagnostic.start();
    diagnostic.stage('readback_requested', attempt);
    void client
      .listProductCatalogTexts(teamId)
      .then(found => {
        if (!active) return;
        diagnostic.confirm(attempt);
        setTexts(found);
        onCount(found.length);
      })
      .catch(error => {
        if (active) {
          setReadError(teamErrorMessageFor(error, t));
          onCount(null);
          diagnostic.fail('READ_FAILED', attempt);
        }
      });
    return () => {
      active = false;
    };
  }, [client, onCount, teamId, revision]);

  const wanted = Number(count);
  const countValid = Number.isInteger(wanted) && wanted >= 1 && wanted <= APPAREL_POOL_MAX;

  /**
   * `mode: 'add'` keeps what the pool holds and generates on top of it, up to the thousand a
   * space may keep: filling a pool used to mean replacing it, so a space that wanted fifty more
   * names had to throw away the ones its catalogs had been drawing from.
   */
  const generate = async (mode: 'add' | 'replace') => {
    if (!client.replaceProductCatalogTexts || !client.listProductCatalogTexts || !countValid)
      return;
    if (!texts || busy || readError || (mode === 'add' && wanted > APPAREL_POOL_MAX - texts.length))
      return;
    setConfirming(false);
    setBusy(true);
    diagnostic.start();
    diagnostic.stage('save_requested');
    try {
      const kept = mode === 'add' ? (texts ?? []) : [];
      const room = Math.max(0, APPAREL_POOL_MAX - kept.length);
      /* Written around the pictures the space has (US27): the names say hoodie where the
         pictures are hoodies, in the colours those pictures are. */
      const capabilities = await client.catalogImages?.capabilities(teamId);
      const inventory =
        capabilities?.mode === 'v2' ? await client.catalogImages?.inventory(teamId) : undefined;
      const pictures = inventory
        ? undefined
        : await client.listProductCatalogPoolNames?.(teamId).catch(() => []);
      const pictured =
        inventory && inventory.pairs.length > 0
          ? {
              garments: [...new Set(inventory.pairs.map(pair => pair.garment))],
              colors: [...new Set(inventory.pairs.map(pair => pair.color))],
              pairs: inventory.pairs
            }
          : pictures && pictures.length > 0
            ? clothesInPictures(pictures)
            : undefined;
      const made = generateApparelTexts(Math.min(wanted, room), undefined, pictured);
      await client.replaceProductCatalogTexts(teamId, [
        ...kept.map(text => ({ title: text.title, description: text.description })),
        ...made
      ]);
      diagnostic.stage('save_confirmed');
      diagnostic.stage('readback_requested');
      const found = await client.listProductCatalogTexts(teamId);
      setTexts(found);
      onCount(found.length);
      setAdding(false);
      diagnostic.confirm();
      push({ tone: 'success', text: t('productCatalogTextsGenerated', { count: made.length }) });
    } catch (error) {
      setReadError(teamErrorMessageFor(error, t));
      onCount(null);
      diagnostic.fail('SAVE_FAILED');
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusy(false);
    }
  };

  if (!client.listProductCatalogTexts) return null;
  const hasPool = (texts?.length ?? 0) > 0;
  const full = (texts?.length ?? 0) >= APPAREL_POOL_MAX;

  return (
    <CatalogSection
      icon={Sparkles}
      titleId="product-catalog-texts-title"
      title={t('productCatalogTextsTitle')}
      description={t('productCatalogTextsDescription')}
      aside={
        readError
          ? t('catalogSettingsReadFailed')
          : texts
            ? t('productCatalogTextsPool', { count: texts.length })
            : t('catalogSettingsLoading')
      }
      className="product-catalog-pool"
    >
      {readError && (
        <ErrorState
          retryLabel={t('catalogUpdaterRetry')}
          message={readError}
          onRetry={() => setRevision(value => value + 1)}
        />
      )}
      {!texts && !readError && <LoadingState count={1} label={t('catalogSettingsLoading')} />}
      <div className="catalog-text-actions">
        {texts && texts.length > 0 && (
          <Button variant="secondary" disabled={busy} onClick={() => setBrowsing(true)}>
            {t('productCatalogTextsBrowse', { count: texts.length })}
          </Button>
        )}
        {editable && texts && !readError && (
          <Button variant="primary" disabled={busy} onClick={() => setAdding(true)}>
            <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('catalogSettingsAddTexts')}
          </Button>
        )}
      </div>
      <CatalogTextScheduleEditor
        teamId={teamId}
        client={client}
        onDraftChange={onScheduleDraftChange}
      />
      {adding && (
        <Modal
          nested
          size="sm"
          title={t('catalogSettingsAddTexts')}
          busy={busy}
          onClose={() => {
            if (!busy) setAdding(false);
          }}
        >
          <div className="catalog-text-generator">
            <div className="catalog-editor-close">
              <IconButton
                title=""
                label={t('catalogImagesClose')}
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                <X />
              </IconButton>
            </div>
            {readError && (
              <ErrorState
                message={readError}
                retryLabel={t('catalogUpdaterRetry')}
                onRetry={() => setRevision(value => value + 1)}
              />
            )}
            {/* Said where the pool is made: the generator knows clothing and nothing else. */}
            <p className="field-hint">{t('productCatalogTextsApparelOnly')}</p>

            {editable && texts && !readError && (
              <div className="product-catalog-generate">
                <div className="catalog-price-field">
                  <label htmlFor={countId}>{t('productCatalogTextsCount')}</label>
                  <Input
                    id={countId}
                    size="sm"
                    className="product-catalog-number"
                    inputMode="numeric"
                    maxLength={4}
                    value={count}
                    invalid={!countValid}
                    onChange={event =>
                      setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 4))
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="primary"
                  loading={busy}
                  disabled={!countValid || full || wanted > APPAREL_POOL_MAX - texts.length}
                  onClick={() => void generate('add')}
                >
                  <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t(hasPool ? 'productCatalogTextsAdd' : 'productCatalogTextsGenerate')}
                </Button>
                {countValid && wanted <= APPAREL_POOL_MAX - texts.length && (
                  <p className="field-hint">
                    {t('catalogSettingsForecast', { count: wanted, total: texts.length + wanted })}
                  </p>
                )}
                {countValid && !full && wanted > APPAREL_POOL_MAX - texts.length && (
                  <Button
                    variant="ghost"
                    onClick={() => setCount(String(APPAREL_POOL_MAX - texts.length))}
                  >
                    {t('catalogSettingsRoom', { count: APPAREL_POOL_MAX - texts.length })}
                  </Button>
                )}
                {hasPool && (
                  <Button
                    variant="link"
                    disabled={!countValid || busy}
                    onClick={() => setConfirming(true)}
                  >
                    {t('productCatalogTextsRegenerate')}
                  </Button>
                )}
                {!countValid && (
                  <small className="team-inline-error">
                    {t('productCatalogTextsCountInvalid', { max: APPAREL_POOL_MAX })}
                  </small>
                )}
                {full && (
                  <small className="field-hint">
                    {t('productCatalogTextsFull', { max: APPAREL_POOL_MAX })}
                  </small>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {browsing && texts && (
        <TextBrowser
          texts={texts}
          editable={editable && !busy && !readError}
          onPick={text => {
            setBrowsing(false);
            setEditing(text);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}

      {confirming && (
        <Modal
          nested
          size="sm"
          title={t('productCatalogTextsRegenerateTitle')}
          onClose={() => setConfirming(false)}
        >
          <p>
            {t('productCatalogTextsRegenerateBody', { count: texts?.length ?? 0, next: wanted })}
          </p>
          <div className="team-dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t('teamCancel')}
            </Button>
            <Button
              type="button"
              color="error"
              variant="outline"
              onClick={() => void generate('replace')}
            >
              {t('productCatalogTextsRegenerate')}
            </Button>
          </div>
        </Modal>
      )}

      {editing && client.updateProductCatalogText && (
        <TextEditor
          text={editing}
          onClose={() => setEditing(null)}
          onSave={async next => {
            diagnostic.start();
            diagnostic.stage('save_requested');
            try {
              const saved = await client.updateProductCatalogText!(teamId, next);
              diagnostic.stage('save_confirmed');
              setTexts(current =>
                (current ?? []).map(item => (item.id === saved.id ? saved : item))
              );
              setEditing(null);
              diagnostic.confirm();
            } catch (error) {
              diagnostic.fail('SAVE_FAILED');
              throw error;
            }
          }}
        />
      )}
    </CatalogSection>
  );
}

/** One name and its description, as two plain fields with their limits said. */
function TextEditor({
  text,
  onClose,
  onSave
}: {
  text: ProductCatalogText;
  onClose: () => void;
  onSave: (text: ProductCatalogText) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  const descriptionId = useId();
  const [title, setTitle] = useState(text.title);
  const [description, setDescription] = useState(text.description);
  const [saving, setSaving] = useState(false);
  const titleOk = title.trim().length >= 1 && title.trim().length <= TITLE_MAX;
  const descriptionOk =
    description.trim().length >= 1 && description.trim().length <= DESCRIPTION_MAX;

  useEffect(() => {
    if (!saving && title === text.title && description === text.description) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [saving, title, description, text]);
  const close = () => {
    if (
      !saving &&
      ((title === text.title && description === text.description) ||
        window.confirm(t('catalogUpdaterDiscardDraft')))
    )
      onClose();
  };
  return (
    <Modal nested size="md" title={t('productCatalogTextsEditTitle')} onClose={close} busy={saving}>
      <form
        className="team-dialog-form"
        onSubmit={event => {
          event.preventDefault();
          if (!titleOk || !descriptionOk) return;
          setSaving(true);
          void onSave({ id: text.id, title: title.trim(), description: description.trim() })
            .catch(error => push({ tone: 'error', text: teamErrorMessageFor(error, t) }))
            .finally(() => setSaving(false));
        }}
      >
        <label htmlFor={titleId}>
          <span>{t('productCatalogTextsFieldTitle')}</span>
          <Input
            id={titleId}
            readOnly={saving}
            value={title}
            maxLength={TITLE_MAX}
            invalid={!titleOk}
            onChange={event => setTitle(event.target.value)}
          />
        </label>
        <small className="field-hint">
          {t('productCatalogTextsFieldTitleHint', { count: title.trim().length, max: TITLE_MAX })}
        </small>
        <label htmlFor={descriptionId}>
          <span>{t('productCatalogTextsFieldDescription')}</span>
          <Textarea
            id={descriptionId}
            className="product-catalog-description"
            rows={5}
            readOnly={saving}
            value={description}
            maxLength={DESCRIPTION_MAX}
            invalid={!descriptionOk}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <small className="field-hint">{t('productCatalogTextsFieldDescriptionHint')}</small>
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {t('teamCancel')}
          </Button>
          <Button
            type="submit"
            color="success"
            loading={saving}
            disabled={!titleOk || !descriptionOk}
          >
            {t('productCatalogSettingsSave')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The whole pool, searchable: a thousand names are worth keeping but not worth scrolling. */
function TextBrowser({
  texts,
  editable,
  onPick,
  onClose
}: {
  texts: readonly ProductCatalogText[];
  editable: boolean;
  onPick: (text: ProductCatalogText) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(TEXTS_PAGE);
  const needle = query.trim().toLocaleLowerCase();
  const found = needle
    ? texts.filter(
        text =>
          text.title.toLocaleLowerCase().includes(needle) ||
          text.description.toLocaleLowerCase().includes(needle)
      )
    : texts;
  return (
    <Modal nested size="lg" title={t('productCatalogTextsBrowseTitle')} onClose={onClose}>
      <div className="product-catalog-browser">
        <div className="catalog-editor-close">
          <IconButton title="" label={t('catalogImagesClose')} onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <Input
          aria-label={t('productCatalogTextsSearch')}
          placeholder={t('productCatalogTextsSearch')}
          value={query}
          leading={<Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          onChange={event => {
            setQuery(event.target.value);
            setShown(TEXTS_PAGE);
          }}
        />
        <p className="field-hint">{t('productCatalogTextsFound', { count: found.length })}</p>
        <ol className="product-catalog-texts">
          {found.slice(0, shown).map(text => (
            <li key={text.id}>
              <button
                type="button"
                className="product-catalog-text"
                disabled={!editable}
                onClick={() => onPick(text)}
              >
                <strong>{text.title}</strong>
              </button>
              {!editable && <p className="field-hint">{text.description}</p>}
            </li>
          ))}
        </ol>
        {found.length > shown && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShown(value => value + TEXTS_PAGE)}
          >
            {t('productCatalogTextsShowMore', { count: found.length - shown })}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Price and the single fallback values
// ---------------------------------------------------------------------------------------------

const snapshot = (...values: string[]) => JSON.stringify(values.map(value => value.trim()));

function CatalogValuesSection({
  teamId,
  client,
  onRange,
  onFallback,
  hasImages,
  hasTexts,
  onDraftChange
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
  onDraftChange?: (state: { dirty: boolean; saving: boolean }) => void;
  onRange: (range: { min: number; max: number }) => void;
  onFallback: (fallback: { title: boolean; image: boolean }) => void;
  /** Both pools have something to draw, so these values are held in reserve rather than used. */
  hasImages: boolean | null;
  hasTexts: boolean | null;
}) {
  const { t } = useI18n();
  const diagnostic = useCatalogSettingsFlow();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const ids = { min: useId(), max: useId(), title: useId(), description: useId(), link: useId() };
  const [readError, setReadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [persisted, setPersisted] = useState<ProductCatalogSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [min, setMin] = useState(String(PRICE_RANGE_DEFAULT.min));
  const [max, setMax] = useState(String(PRICE_RANGE_DEFAULT.max));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  // What the space holds, to tell an edit from what is already saved: nothing said whether a
  // changed price was kept. Nothing stored yet (null) is not the defaults stored — without a row
  // a catalog has no price at all. The two cards track their own halves.
  const [savedPrice, setSavedPrice] = useState<string | null>(null);
  const [savedFallback, setSavedFallback] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setReadError(null);
    const attempt = diagnostic.start();
    diagnostic.stage('readback_requested', attempt);
    void client
      .getProductCatalogSettings(teamId)
      .then(found => {
        if (!active) return;
        diagnostic.confirm(attempt);
        setLoaded(true);
        setPersisted(found);
        if (!found) {
          onFallback({ title: false, image: false });
          setSavedFallback(snapshot('', '', ''));
          return;
        }
        setMin(String(found.priceMin));
        setMax(String(found.priceMax));
        setTitle(found.title ?? '');
        setDescription(found.description ?? '');
        setLink(found.imageLink ?? '');
        setSavedPrice(snapshot(String(found.priceMin), String(found.priceMax)));
        setSavedFallback(
          snapshot(found.title ?? '', found.description ?? '', found.imageLink ?? '')
        );
        onRange({ min: found.priceMin, max: found.priceMax });
        onFallback({ title: Boolean(found.title), image: Boolean(found.imageLink) });
      })
      .catch(error => {
        if (active) {
          setReadError(teamErrorMessageFor(error, t));
          diagnostic.fail('READ_FAILED', attempt);
        }
      });
    return () => {
      active = false;
    };
  }, [client, teamId, revision]);

  const minCheck = validatePrice(min);
  const maxCheck = validatePrice(max);
  const rangeOk = minCheck.ok && maxCheck.ok && minCheck.value <= maxCheck.value;
  const linkCheck = link.trim() === '' ? null : validateWebLink(link, IMAGE_LINK_MAX);
  const linkOk = linkCheck === null || linkCheck.ok;
  const titleOk = title.trim().length <= TITLE_MAX;
  const descriptionOk = description.trim().length <= DESCRIPTION_MAX;
  const valid = rangeOk && linkOk && titleOk && descriptionOk;
  const fallbackUsed = Boolean(persisted?.title || persisted?.description || persisted?.imageLink);

  useEffect(
    () => () => {
      onDraftChange?.({ dirty: false, saving: false });
    },
    [onDraftChange]
  );
  const priceDirty = loaded && snapshot(min, max) !== savedPrice;
  const fallbackDirty = loaded && snapshot(title, description, link) !== savedFallback;
  useEffect(() => {
    onDraftChange?.({ dirty: priceDirty || fallbackDirty, saving });
  }, [priceDirty, fallbackDirty, saving, onDraftChange]);
  useEffect(() => {
    if (!priceDirty && !fallbackDirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [priceDirty, fallbackDirty, saving]);
  const save = async (part: 'price' | 'fallback') => {
    if (
      !loaded ||
      saving ||
      !editable ||
      (part === 'price' ? !rangeOk : !linkOk || !titleOk || !descriptionOk || !persisted)
    )
      return;
    setSaving(true);
    diagnostic.start();
    diagnostic.stage('save_requested');
    try {
      const result = await client.setProductCatalogSettings(teamId, {
        title: part === 'fallback' ? title.trim() || null : (persisted?.title ?? null),
        description:
          part === 'fallback' ? description.trim() || null : (persisted?.description ?? null),
        imageLink:
          part === 'fallback'
            ? linkCheck?.ok
              ? linkCheck.value
              : null
            : (persisted?.imageLink ?? null),
        priceMin: part === 'price' && minCheck.ok ? minCheck.value : persisted!.priceMin,
        priceMax: part === 'price' && maxCheck.ok ? maxCheck.value : persisted!.priceMax
      });
      diagnostic.stage('save_confirmed');
      setPersisted(result);
      diagnostic.confirm();
      if (part === 'price') {
        setMin(String(result.priceMin));
        setMax(String(result.priceMax));
        setSavedPrice(snapshot(String(result.priceMin), String(result.priceMax)));
      } else {
        setTitle(result.title ?? '');
        setDescription(result.description ?? '');
        setLink(result.imageLink ?? '');
        setSavedFallback(
          snapshot(result.title ?? '', result.description ?? '', result.imageLink ?? '')
        );
      }
      onRange({ min: result.priceMin, max: result.priceMax });
      onFallback({ title: Boolean(result.title), image: Boolean(result.imageLink) });
      push({ tone: 'success', text: t('productCatalogSettingsSaved') });
    } catch (error) {
      diagnostic.fail('SAVE_FAILED');
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <CatalogSection
        icon={DollarSign}
        titleId="product-catalog-settings-title"
        title={t('productCatalogPriceTitle')}
        description={t('productCatalogPriceDescription')}
        aside={
          readError
            ? t('catalogSettingsReadFailed')
            : !loaded
              ? t('catalogSettingsLoading')
              : priceDirty
                ? t('productCatalogUnsaved')
                : persisted
                  ? `${persisted.priceMin}–${persisted.priceMax} USD`
                  : t('productCatalogSummaryPriceUnsaved')
        }
        className="product-catalog-settings"
      >
        {readError && (
          <ErrorState
            retryLabel={t('catalogUpdaterRetry')}
            message={readError}
            onRetry={() => setRevision(value => value + 1)}
          />
        )}
        {!loaded && !readError && <LoadingState count={1} label={t('catalogSettingsLoading')} />}
        {!editable && <p className="team-inline-note">{t('productCatalogSettingsReadOnly')}</p>}
        <div className="product-catalog-price-range">
          <div className="catalog-price-field">
            <label htmlFor={ids.min}>{t('productCatalogPriceFrom')}</label>
            <Input
              id={ids.min}
              size="sm"
              className="product-catalog-number"
              inputMode="numeric"
              maxLength={6}
              value={min}
              readOnly={!editable || saving || !loaded}
              invalid={!rangeOk}
              onChange={event => setMin(event.target.value.replace(/[^\d]/gu, ''))}
            />
          </div>
          <div className="catalog-price-field">
            <label htmlFor={ids.max}>{t('productCatalogPriceTo')}</label>
            <Input
              id={ids.max}
              size="sm"
              className="product-catalog-number"
              inputMode="numeric"
              maxLength={6}
              value={max}
              readOnly={!editable || saving || !loaded}
              invalid={!rangeOk}
              onChange={event => setMax(event.target.value.replace(/[^\d]/gu, ''))}
            />
          </div>
          <span className="field-hint">USD</span>
          {editable && (
            <div className="catalog-price-actions">
              <Button
                type="button"
                color="success"
                loading={saving}
                disabled={!loaded || !rangeOk || !priceDirty}
                onClick={() => void save('price')}
              >
                {t('productCatalogSettingsSave')}
              </Button>
              {loaded && priceDirty && rangeOk && (
                <span className="product-catalog-unsaved">{t('productCatalogUnsaved')}</span>
              )}
            </div>
          )}
        </div>
        {!rangeOk && <p className="team-inline-error">{t('productCatalogPriceRangeInvalid')}</p>}
      </CatalogSection>

      {/* The one title, description and picture link every row used to share. They sat inside the
          price card, where the button under them looked like the price's own; here they are a
          section of their own, folded, with what they are for said once. */}
      <CatalogSection
        icon={FileSpreadsheet}
        titleId="product-catalog-fallback-title"
        title={t('productCatalogFallbackTitle')}
        description={t('productCatalogFallbackHint')}
        aside={
          fallbackDirty
            ? t('productCatalogUnsaved')
            : hasImages === null || hasTexts === null
              ? t('catalogSettingsUnknown')
              : t(
                  !fallbackUsed
                    ? 'productCatalogFallbackEmpty'
                    : hasImages && hasTexts
                      ? 'productCatalogFallbackUnused'
                      : 'productCatalogFallbackInUse'
                )
        }
        className="product-catalog-settings"
      >
        {!persisted && <p className="field-hint">{t('catalogSettingsSavePriceFirst')}</p>}
        <div className="product-catalog-fallback">
          {persisted?.title && (
            <p className="field-hint">
              {t(
                hasTexts === null
                  ? 'catalogSettingsUnknown'
                  : hasTexts
                    ? 'catalogFallbackReserved'
                    : 'catalogFallbackTitleActive'
              )}
            </p>
          )}
          {persisted?.imageLink && (
            <p className="field-hint">
              {t(
                hasImages === null
                  ? 'catalogSettingsUnknown'
                  : hasImages
                    ? 'catalogFallbackReserved'
                    : 'catalogFallbackImageActive'
              )}
            </p>
          )}
          <div className="field-group">
            <label className="field-label" htmlFor={ids.title}>
              <span>{t('productCatalogTitleLabel')}</span>
            </label>
            <Input
              id={ids.title}
              value={title}
              maxLength={TITLE_MAX + 50}
              readOnly={!editable || saving || !loaded}
              onChange={event => setTitle(event.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor={ids.description}>
              <span>{t('productCatalogDescriptionLabel')}</span>
            </label>
            <Textarea
              id={ids.description}
              className="product-catalog-description"
              rows={3}
              value={description}
              maxLength={DESCRIPTION_MAX + 50}
              readOnly={!editable || saving || !loaded}
              onChange={event => setDescription(event.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor={ids.link}>
              <span>{t('productCatalogImageLinkLabel')}</span>
            </label>
            <Input
              id={ids.link}
              type="text"
              inputMode="url"
              value={link}
              readOnly={!editable || saving || !loaded}
              invalid={!linkOk}
              onChange={event => setLink(event.target.value)}
            />
          </div>
          {!linkOk && <p className="team-inline-error">{t('productCatalogLinkInvalid')}</p>}
          {editable && (
            <div className="settings-section-actions">
              <Button
                type="button"
                color="success"
                loading={saving}
                disabled={
                  !loaded || !persisted || !linkOk || !titleOk || !descriptionOk || !fallbackDirty
                }
                onClick={() => void save('fallback')}
              >
                {t('productCatalogFallbackSave')}
              </Button>
              {loaded && fallbackDirty && valid && (
                <span className="product-catalog-unsaved">{t('productCatalogUnsaved')}</span>
              )}
            </div>
          )}
        </div>
      </CatalogSection>
    </>
  );
}

function CatalogTextScheduleEditor({
  teamId,
  client,
  onDraftChange
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
  onDraftChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const { t, language } = useI18n();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const diagnostic = useCatalogSettingsFlow();
  const [saved, setSaved] = useState<ProductCatalogTextSchedule | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState('200');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  const countId = useId();
  const hintId = useId();
  const supported = Boolean(
    client.getProductCatalogTextSchedule && client.setProductCatalogTextSchedule
  );
  const dirty = saved !== null && (enabled !== saved.enabled || count !== String(saved.count));
  const amount = Number(count);
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= APPAREL_POOL_MAX;
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const attempt = diagnostic.start();
    diagnostic.stage('readback_requested', attempt);
    setError(null);
    setSaved(null);
    setConfirmed(false);
    void client.getProductCatalogTextSchedule!(teamId)
      .then(value => {
        if (!active) return;
        setSaved(value);
        setEnabled(value.enabled);
        setCount(String(value.count));
        diagnostic.confirm(attempt);
      })
      .catch(cause => {
        if (!active) return;
        setError(teamErrorMessageFor(cause, t));
        diagnostic.fail('READ_FAILED', attempt);
      });
    return () => {
      active = false;
    };
  }, [client, teamId, supported, revision, diagnostic, t]);
  useEffect(() => {
    onDraftChange({ dirty, saving });
  }, [dirty, saving, onDraftChange]);
  useEffect(() => () => onDraftChange({ dirty: false, saving: false }), [onDraftChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);
  const save = async () => {
    if (!supported || !editable || !saved || !dirty || saving || !valid) return;
    const expected = { enabled, count: amount };
    diagnostic.start();
    diagnostic.stage('save_requested');
    setSaving(true);
    setError(null);
    setConfirmed(false);
    try {
      await client.setProductCatalogTextSchedule!(teamId, expected);
      diagnostic.stage('save_confirmed');
      diagnostic.stage('readback_requested');
      const result = await client.getProductCatalogTextSchedule!(teamId);
      if (result.enabled !== expected.enabled || result.count !== expected.count)
        throw new Error('Schedule save unconfirmed');
      setSaved(result);
      setEnabled(result.enabled);
      setCount(String(result.count));
      setConfirmed(true);
      diagnostic.confirm();
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
      diagnostic.fail('SAVE_FAILED');
    } finally {
      setSaving(false);
    }
  };
  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  if (!supported) return <p className="field-hint">{t('catalogTextScheduleUnavailable')}</p>;
  return (
    <section className="catalog-text-schedule" aria-label={t('catalogTextScheduleTitle')}>
      {!saved && !error && <LoadingState count={1} label={t('catalogTextScheduleLoading')} />}
      {error && (
        <ErrorState
          message={error}
          retryLabel={t('catalogUpdaterRetry')}
          onRetry={() => (saved ? void save() : setRevision(value => value + 1))}
        />
      )}
      {saved && (
        <>
          <div className="catalog-text-schedule-row">
            <Switch
              label={t('catalogTextScheduleTitle')}
              checked={enabled}
              disabled={!editable || saving}
              aria-describedby={hintId}
              onChange={value => {
                setEnabled(value);
                if (!value && !valid) setCount(String(saved.count));
                setConfirmed(false);
              }}
            />
            {enabled && (
              <div className="catalog-text-schedule-count">
                <label htmlFor={countId}>{t('catalogTextScheduleCount')}</label>
                <Input
                  id={countId}
                  className="product-catalog-number"
                  size="sm"
                  inputMode="numeric"
                  maxLength={4}
                  value={count}
                  readOnly={!editable || saving}
                  invalid={count !== '' && !valid}
                  onChange={event => {
                    setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 4));
                    setConfirmed(false);
                  }}
                />
              </div>
            )}
            {editable && (
              <Button
                color="success"
                disabled={!dirty || !valid || saving}
                loading={saving}
                onClick={() => void save()}
              >
                {t('catalogTextScheduleSave')}
              </Button>
            )}
          </div>
          <p id={hintId} className="field-hint prose">
            {t('catalogTextScheduleConsequence')}
          </p>
          {enabled && count !== '' && !valid && (
            <p className="team-inline-error">
              {t('productCatalogTextsCountInvalid', { max: APPAREL_POOL_MAX })}
            </p>
          )}
          {dirty && <p className="field-hint">{t('productCatalogUnsaved')}</p>}
          {confirmed && (
            <p role="status" className="field-hint">
              {t('catalogTextScheduleSaved')}
            </p>
          )}
          {saved.enabled && saved.nextRunAt && (
            <p className="field-hint">
              {t('catalogTextScheduleNext', { date: dateLabel(saved.nextRunAt) })}
            </p>
          )}
          {saved.enabled && !saved.nextRunAt && (
            <p className="field-hint">{t('catalogTextScheduleNextUnknown')}</p>
          )}
          {saved.lastRunAt && (
            <p className="field-hint">
              {t('catalogTextScheduleLast', { date: dateLabel(saved.lastRunAt) })}
            </p>
          )}
          {saved.lastError && (
            <div className="catalog-text-schedule-row">
              <p role="alert" className="team-inline-error">
                {t('catalogTextScheduleLastFailed')}
              </p>
              <Button
                variant="ghost"
                disabled={dirty || saving}
                onClick={() => setRevision(value => value + 1)}
              >
                {t('catalogImagesRefresh')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
