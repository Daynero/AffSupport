import { useEffect, useId, useState } from 'react';
import {
  Check,
  ClipboardList,
  DollarSign,
  FileSpreadsheet,
  Folder,
  Image,
  Search,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react';
import type {
  ProductCatalogImageSource,
  ProductCatalogSettings,
  ProductCatalogText,
  TeamMaterialSummary
} from '../../api/team';
import { Button, IconButton, Input, Modal } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { SettingsSection } from '../workspace/SettingsSection';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import {
  TaskAttachmentPicker,
  type TaskAttachmentPickerClient
} from '../tasks/TaskAttachmentPicker';
import { APPAREL_POOL_DEFAULT, APPAREL_POOL_MAX, generateApparelTexts } from './apparelTexts';
import {
  DESCRIPTION_MAX,
  IMAGE_LINK_MAX,
  TITLE_MAX,
  validatePrice,
  validateWebLink
} from './limits';

export interface ProductCatalogSettingsClient {
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
  client
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
}) {
  const [images, setImages] = useState<number | null>(null);
  const [texts, setTexts] = useState<number | null>(null);
  const [fallback, setFallback] = useState<{ title: boolean; image: boolean } | null>(null);
  const [range, setRange] = useState<{ min: number; max: number } | null>(null);
  return (
    <>
      <CatalogSummarySection
        images={images}
        texts={texts}
        fallback={fallback}
        range={range}
        hasImageSources={Boolean(client.listProductCatalogImageSources)}
        hasTextPool={Boolean(client.listProductCatalogTexts)}
      />
      <CatalogTextsSection teamId={teamId} client={client} onCount={setTexts} />
      <CatalogImagesSection teamId={teamId} client={client} onPool={setImages} />
      <CatalogValuesSection
        teamId={teamId}
        client={client}
        onRange={setRange}
        onFallback={setFallback}
        poolsFilled={(images ?? 0) > 0 && (texts ?? 0) > 0}
      />
    </>
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
  hasTextPool
}: {
  images: number | null;
  texts: number | null;
  fallback: { title: boolean; image: boolean } | null;
  range: { min: number; max: number } | null;
  hasImageSources: boolean;
  hasTextPool: boolean;
}) {
  const { t } = useI18n();
  if (fallback === null) return null;
  const nameState = (texts ?? 0) > 0 ? 'pool' : fallback.title ? 'fallback' : 'missing';
  const imageState = (images ?? 0) > 0 ? 'pool' : fallback.image ? 'fallback' : 'missing';
  const blocked = nameState === 'missing' || imageState === 'missing';
  const line = (
    state: 'pool' | 'fallback' | 'missing',
    keys: { pool: TranslationKey; fallback: TranslationKey; missing: TranslationKey },
    count: number
  ) => (
    <li className={`is-${state === 'missing' ? 'missing' : state === 'pool' ? 'ready' : 'spare'}`}>
      {state === 'missing' ? (
        <TriangleAlert size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
      ) : (
        <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
      )}
      <span>{t(keys[state], { count })}</span>
    </li>
  );
  return (
    <SettingsSection
      icon={ClipboardList}
      titleId="product-catalog-summary-title"
      title={t('productCatalogSummaryTitle')}
      description={t('productCatalogSummaryDescription')}
      className="product-catalog-summary"
    >
      <ul className="product-catalog-summary-list">
        {hasTextPool &&
          line(
            nameState,
            {
              pool: 'productCatalogSummaryNames',
              fallback: 'productCatalogSummaryNamesFallback',
              missing: 'productCatalogSummaryNamesMissing'
            },
            texts ?? 0
          )}
        {hasImageSources &&
          line(
            imageState,
            {
              pool: 'productCatalogSummaryImages',
              fallback: 'productCatalogSummaryImagesFallback',
              missing: 'productCatalogSummaryImagesMissing'
            },
            images ?? 0
          )}
        <li className="is-ready">
          <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>
            {range
              ? t('productCatalogSummaryPrice', { from: range.min, to: range.max })
              : t('productCatalogSummaryPriceUnsaved')}
          </span>
        </li>
      </ul>
      <p className={blocked ? 'team-inline-error' : 'field-hint'}>
        {t(blocked ? 'productCatalogSummaryBlocked' : 'productCatalogSummaryReady')}
      </p>
      <a
        className="product-catalog-updater-link"
        href={updaterHref()}
        onClick={event => {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          navigateTo(updaterHref());
        }}
      >
        {t('productCatalogUpdaterLink')}
      </a>
    </SettingsSection>
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
  onPool
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
  onPool: (count: number) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const [sources, setSources] = useState<ProductCatalogImageSource[] | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [pickingFolder, setPickingFolder] = useState(false);

  const load = async () => {
    if (!client.listProductCatalogImageSources) return;
    try {
      const found = await client.listProductCatalogImageSources(teamId);
      setSources(found.sources);
      setPoolSize(found.poolSize);
      onPool(found.poolSize);
    } catch {
      setSources([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const save = async (next: ReadonlyArray<{ materialId: string; kind: 'file' | 'folder' }>) => {
    if (!client.setProductCatalogImageSources) return;
    try {
      await client.setProductCatalogImageSources(teamId, next);
      await load();
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    }
  };

  const current = (sources ?? []).map(source => ({
    materialId: source.materialId,
    kind: source.kind
  }));

  if (!client.listProductCatalogImageSources) return null;

  return (
    <SettingsSection
      icon={Image}
      titleId="product-catalog-images-title"
      title={t('productCatalogImagesTitle')}
      description={t('productCatalogImagesDescription')}
      aside={sources ? t('productCatalogImagesPool', { count: poolSize }) : undefined}
      className="product-catalog-pool"
    >
      {sources && sources.length > 0 && (
        <ul className="product-catalog-sources">
          {sources.map(source => (
            <li key={source.materialId}>
              {source.kind === 'folder' ? (
                <Folder size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <Image size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
              <span className="product-catalog-source-name" title={source.name}>
                {source.name}
              </span>
              {source.kind === 'folder' && (
                <small>{t('productCatalogImagesInFolder', { count: source.imageCount })}</small>
              )}
              {editable && (
                <IconButton
                  size="xs"
                  variant="ghost"
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
      {editable && client.listMaterials && client.attachTaskMaterials !== undefined && (
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
              <Button type="button" variant="secondary" onClick={open}>
                <Image size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
          <Button type="button" variant="secondary" onClick={() => setPickingFolder(true)}>
            <Folder size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------
// Names and descriptions
// ---------------------------------------------------------------------------------------------

/** A sample in the tab, a page at a time in the browser. */
const TEXTS_SHOWN = 3;
const TEXTS_PAGE = 50;

function CatalogTextsSection({
  teamId,
  client,
  onCount
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
  onCount: (count: number) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const countId = useId();
  const [texts, setTexts] = useState<ProductCatalogText[] | null>(null);
  const [count, setCount] = useState(String(APPAREL_POOL_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState<ProductCatalogText | null>(null);

  useEffect(() => {
    if (!client.listProductCatalogTexts) return;
    let active = true;
    void client
      .listProductCatalogTexts(teamId)
      .then(found => {
        if (!active) return;
        setTexts(found);
        onCount(found.length);
      })
      .catch(() => {
        if (active) setTexts([]);
      });
    return () => {
      active = false;
    };
  }, [client, onCount, teamId]);

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
    setConfirming(false);
    setBusy(true);
    try {
      const kept = mode === 'add' ? (texts ?? []) : [];
      const room = Math.max(0, APPAREL_POOL_MAX - kept.length);
      const made = generateApparelTexts(Math.min(wanted, room));
      await client.replaceProductCatalogTexts(teamId, [
        ...kept.map(text => ({ title: text.title, description: text.description })),
        ...made
      ]);
      const found = await client.listProductCatalogTexts(teamId);
      setTexts(found);
      onCount(found.length);
      push({ tone: 'success', text: t('productCatalogTextsGenerated', { count: made.length }) });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusy(false);
    }
  };

  if (!client.listProductCatalogTexts) return null;
  const hasPool = (texts?.length ?? 0) > 0;
  const full = (texts?.length ?? 0) >= APPAREL_POOL_MAX;

  return (
    <SettingsSection
      icon={Sparkles}
      titleId="product-catalog-texts-title"
      title={t('productCatalogTextsTitle')}
      description={t('productCatalogTextsDescription')}
      aside={texts ? t('productCatalogTextsPool', { count: texts.length }) : undefined}
      className="product-catalog-pool"
    >
      {/* Said where the pool is made: the generator knows clothing and nothing else. */}
      <p className="product-catalog-warning">{t('productCatalogTextsApparelOnly')}</p>

      {editable && (
        <div className="product-catalog-generate">
          <label htmlFor={countId}>{t('productCatalogTextsCount')}</label>
          <Input
            id={countId}
            size="sm"
            className="product-catalog-number"
            inputMode="numeric"
            maxLength={4}
            value={count}
            aria-invalid={!countValid}
            onChange={event => setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 4))}
          />
          <Button
            type="button"
            variant="primary"
            loading={busy}
            disabled={!countValid || full}
            onClick={() => void generate('add')}
          >
            <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(hasPool ? 'productCatalogTextsAdd' : 'productCatalogTextsGenerate')}
          </Button>
          {hasPool && (
            <Button
              type="button"
              variant="ghost"
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

      {/* Three of them, as a sample of what the generator writes. A thousand names listed in a
          settings tab is a wall nobody reads and a page nobody can scroll past; the rest are a
          click away, where they can be searched. */}
      {texts && texts.length > 0 && (
        <>
          <ol className="product-catalog-texts">
            {texts.slice(0, TEXTS_SHOWN).map(text => (
              <li key={text.id}>
                <button
                  type="button"
                  className="product-catalog-text"
                  disabled={!editable}
                  onClick={() => setEditing(text)}
                >
                  <strong>{text.title}</strong>
                  <span>{text.description}</span>
                </button>
              </li>
            ))}
          </ol>
          <Button type="button" variant="ghost" onClick={() => setBrowsing(true)}>
            {t('productCatalogTextsBrowse', { count: texts.length })}
          </Button>
        </>
      )}

      {browsing && texts && (
        <TextBrowser
          texts={texts}
          editable={editable}
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
          <p>{t('productCatalogTextsRegenerateBody', { count: texts?.length ?? 0 })}</p>
          <div className="team-dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t('teamCancel')}
            </Button>
            <Button type="button" variant="primary" onClick={() => void generate('replace')}>
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
            const saved = await client.updateProductCatalogText!(teamId, next);
            setTexts(current => (current ?? []).map(item => (item.id === saved.id ? saved : item)));
            setEditing(null);
          }}
        />
      )}
    </SettingsSection>
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

  return (
    <Modal
      nested
      size="md"
      title={t('productCatalogTextsEditTitle')}
      onClose={onClose}
      busy={saving}
    >
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
          <input
            id={titleId}
            value={title}
            maxLength={TITLE_MAX}
            aria-invalid={!titleOk}
            onChange={event => setTitle(event.target.value)}
          />
        </label>
        <small className="field-hint">
          {t('productCatalogTextsFieldTitleHint', { count: title.trim().length, max: TITLE_MAX })}
        </small>
        <label htmlFor={descriptionId}>
          <span>{t('productCatalogTextsFieldDescription')}</span>
          <textarea
            id={descriptionId}
            className="product-catalog-description"
            rows={5}
            value={description}
            maxLength={DESCRIPTION_MAX}
            aria-invalid={!descriptionOk}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <small className="field-hint">{t('productCatalogTextsFieldDescriptionHint')}</small>
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
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
        <Input
          aria-label={t('productCatalogTextsSearch')}
          placeholder={t('productCatalogTextsSearch')}
          value={query}
          leading={<Search size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
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
                <span>{text.description}</span>
              </button>
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
  poolsFilled
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
  onRange: (range: { min: number; max: number }) => void;
  onFallback: (fallback: { title: boolean; image: boolean }) => void;
  /** Both pools have something to draw, so these values are held in reserve rather than used. */
  poolsFilled: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const editable = can('manage_metadata');
  const ids = { min: useId(), max: useId(), title: useId(), description: useId(), link: useId() };
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [min, setMin] = useState(String(PRICE_RANGE_DEFAULT.min));
  const [max, setMax] = useState(String(PRICE_RANGE_DEFAULT.max));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [fallbackOpen, setFallbackOpen] = useState(false);
  // What the space holds, to tell an edit from what is already saved: nothing said whether a
  // changed price was kept. Nothing stored yet (null) is not the defaults stored — without a row
  // a catalog has no price at all. The two cards track their own halves.
  const [savedPrice, setSavedPrice] = useState<string | null>(null);
  const [savedFallback, setSavedFallback] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .getProductCatalogSettings(teamId)
      .then(found => {
        if (!active || !found) return;
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
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, teamId]);

  const minCheck = validatePrice(min);
  const maxCheck = validatePrice(max);
  const rangeOk = minCheck.ok && maxCheck.ok && minCheck.value <= maxCheck.value;
  const linkCheck = link.trim() === '' ? null : validateWebLink(link, IMAGE_LINK_MAX);
  const linkOk = linkCheck === null || linkCheck.ok;
  const titleOk = title.trim().length <= TITLE_MAX;
  const descriptionOk = description.trim().length <= DESCRIPTION_MAX;
  const valid = rangeOk && linkOk && titleOk && descriptionOk;
  const fallbackUsed = Boolean(title.trim() || description.trim() || link.trim());

  const save = async () => {
    if (!valid || !minCheck.ok || !maxCheck.ok) return;
    setSaving(true);
    try {
      await client.setProductCatalogSettings(teamId, {
        title: title.trim() || null,
        description: description.trim() || null,
        imageLink: linkCheck?.ok ? linkCheck.value : null,
        priceMin: minCheck.value,
        priceMax: maxCheck.value
      });
      setSavedPrice(snapshot(min, max));
      setSavedFallback(snapshot(title, description, link));
      onRange({ min: minCheck.value, max: maxCheck.value });
      onFallback({ title: Boolean(title.trim()), image: Boolean(link.trim()) });
      push({ tone: 'success', text: t('productCatalogSettingsSaved') });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const priceDirty = snapshot(min, max) !== savedPrice;
  const fallbackDirty = snapshot(title, description, link) !== savedFallback;

  return (
    <>
      <SettingsSection
        icon={DollarSign}
        titleId="product-catalog-settings-title"
        title={t('productCatalogPriceTitle')}
        description={t('productCatalogPriceDescription')}
        aside={
          rangeOk && minCheck.ok && maxCheck.ok
            ? minCheck.value === maxCheck.value
              ? `${minCheck.value} USD`
              : `${minCheck.value}\u2013${maxCheck.value} USD`
            : undefined
        }
        className="product-catalog-settings"
      >
        {!editable && <p className="team-inline-note">{t('productCatalogSettingsReadOnly')}</p>}
        <div className="product-catalog-price-range">
          <label htmlFor={ids.min}>{t('productCatalogPriceFrom')}</label>
          <Input
            id={ids.min}
            size="sm"
            className="product-catalog-number"
            inputMode="numeric"
            maxLength={6}
            value={min}
            readOnly={!editable}
            aria-invalid={!rangeOk}
            onChange={event => setMin(event.target.value.replace(/[^\d]/gu, ''))}
          />
          <label htmlFor={ids.max}>{t('productCatalogPriceTo')}</label>
          <Input
            id={ids.max}
            size="sm"
            className="product-catalog-number"
            inputMode="numeric"
            maxLength={6}
            value={max}
            readOnly={!editable}
            aria-invalid={!rangeOk}
            onChange={event => setMax(event.target.value.replace(/[^\d]/gu, ''))}
          />
          <span>USD</span>
        </div>
        {!rangeOk && <p className="team-inline-error">{t('productCatalogPriceRangeInvalid')}</p>}
        {editable && (
          <div className="settings-section-actions">
            <Button
              type="button"
              variant="primary"
              loading={saving}
              disabled={!loaded || !valid || !priceDirty}
              onClick={() => void save()}
            >
              {t('productCatalogSettingsSave')}
            </Button>
            {loaded && priceDirty && rangeOk && (
              <span className="product-catalog-unsaved">{t('productCatalogUnsaved')}</span>
            )}
          </div>
        )}
      </SettingsSection>

      {/* The one title, description and picture link every row used to share. They sat inside the
          price card, where the button under them looked like the price's own; here they are a
          section of their own, folded, with what they are for said once. */}
      <SettingsSection
        icon={FileSpreadsheet}
        titleId="product-catalog-fallback-title"
        title={t('productCatalogFallbackTitle')}
        description={t('productCatalogFallbackHint')}
        aside={t(
          !fallbackUsed
            ? 'productCatalogFallbackEmpty'
            : poolsFilled
              ? 'productCatalogFallbackUnused'
              : 'productCatalogFallbackInUse'
        )}
        className="product-catalog-settings"
      >
        <button
          type="button"
          className="product-catalog-fallback-toggle"
          aria-expanded={fallbackOpen}
          onClick={() => setFallbackOpen(open => !open)}
        >
          <FileSpreadsheet size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('productCatalogFallbackToggle')}
        </button>
        {fallbackOpen && (
          <div className="product-catalog-fallback">
            <div className="field-group">
              <label className="field-label" htmlFor={ids.title}>
                <span>{t('productCatalogTitleLabel')}</span>
              </label>
              <input
                id={ids.title}
                value={title}
                maxLength={TITLE_MAX + 50}
                readOnly={!editable}
                onChange={event => setTitle(event.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor={ids.description}>
                <span>{t('productCatalogDescriptionLabel')}</span>
              </label>
              <textarea
                id={ids.description}
                className="product-catalog-description"
                rows={3}
                value={description}
                maxLength={DESCRIPTION_MAX + 50}
                readOnly={!editable}
                onChange={event => setDescription(event.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor={ids.link}>
                <span>{t('productCatalogImageLinkLabel')}</span>
              </label>
              <input
                id={ids.link}
                type="text"
                inputMode="url"
                value={link}
                readOnly={!editable}
                aria-invalid={!linkOk}
                onChange={event => setLink(event.target.value)}
              />
            </div>
            {!linkOk && <p className="team-inline-error">{t('productCatalogLinkInvalid')}</p>}
            {editable && (
              <div className="settings-section-actions">
                <Button
                  type="button"
                  variant="secondary"
                  loading={saving}
                  disabled={!loaded || !valid || !fallbackDirty}
                  onClick={() => void save()}
                >
                  {t('productCatalogFallbackSave')}
                </Button>
                {loaded && fallbackDirty && valid && (
                  <span className="product-catalog-unsaved">{t('productCatalogUnsaved')}</span>
                )}
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </>
  );
}
