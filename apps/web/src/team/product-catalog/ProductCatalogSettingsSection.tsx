import { useEffect, useId, useState } from 'react';
import { DollarSign, FileSpreadsheet, Folder, Image, Sparkles, X } from 'lucide-react';
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
 * Three parts, each answering one question: which pictures, which names and descriptions, what
 * price. Pictures come from the space — images and whole folders — and names from a pool the
 * space keeps; each row of a catalog draws its own, none repeated until the pool is used up. One
 * name, description and picture link for every row are still there, folded away, for a space
 * that has no pools.
 */
export function ProductCatalogSettingsSection({
  teamId,
  client
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
}) {
  return (
    <>
      <CatalogImagesSection teamId={teamId} client={client} />
      <CatalogTextsSection teamId={teamId} client={client} />
      <CatalogValuesSection teamId={teamId} client={client} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------

function CatalogImagesSection({
  teamId,
  client
}: {
  teamId: string;
  client: ProductCatalogSettingsClient & Partial<TaskAttachmentPickerClient & FolderPickerClient>;
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

const TEXTS_SHOWN = 30;

function CatalogTextsSection({
  teamId,
  client
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
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
  const [shown, setShown] = useState(TEXTS_SHOWN);
  const [editing, setEditing] = useState<ProductCatalogText | null>(null);

  useEffect(() => {
    if (!client.listProductCatalogTexts) return;
    let active = true;
    void client
      .listProductCatalogTexts(teamId)
      .then(found => {
        if (active) setTexts(found);
      })
      .catch(() => {
        if (active) setTexts([]);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const wanted = Number(count);
  const countValid = Number.isInteger(wanted) && wanted >= 1 && wanted <= APPAREL_POOL_MAX;

  const generate = async () => {
    if (!client.replaceProductCatalogTexts || !client.listProductCatalogTexts || !countValid)
      return;
    setConfirming(false);
    setBusy(true);
    try {
      await client.replaceProductCatalogTexts(teamId, generateApparelTexts(wanted));
      setTexts(await client.listProductCatalogTexts(teamId));
      setShown(TEXTS_SHOWN);
      push({ tone: 'success', text: t('productCatalogTextsGenerated', { count: wanted }) });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusy(false);
    }
  };

  if (!client.listProductCatalogTexts) return null;
  const hasPool = (texts?.length ?? 0) > 0;

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
            variant={hasPool ? 'secondary' : 'primary'}
            loading={busy}
            disabled={!countValid}
            onClick={() => (hasPool ? setConfirming(true) : void generate())}
          >
            <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(hasPool ? 'productCatalogTextsRegenerate' : 'productCatalogTextsGenerate')}
          </Button>
          {!countValid && (
            <small className="team-inline-error">
              {t('productCatalogTextsCountInvalid', { max: APPAREL_POOL_MAX })}
            </small>
          )}
        </div>
      )}

      {texts && texts.length > 0 && (
        <ol className="product-catalog-texts">
          {texts.slice(0, shown).map(text => (
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
      )}
      {texts && texts.length > shown && (
        <Button type="button" variant="ghost" onClick={() => setShown(value => value + 100)}>
          {t('productCatalogTextsShowMore', { count: texts.length - shown })}
        </Button>
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
            <Button type="button" variant="primary" onClick={() => void generate()}>
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

// ---------------------------------------------------------------------------------------------
// Price and the single fallback values
// ---------------------------------------------------------------------------------------------

const snapshot = (...values: string[]) => JSON.stringify(values.map(value => value.trim()));

function CatalogValuesSection({
  teamId,
  client
}: {
  teamId: string;
  client: ProductCatalogSettingsClient;
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
  // What the space holds, to tell an edit from what is already saved: with one button under
  // both the price and the collapsed fallback, nothing said whether a changed price was kept.
  // Nothing stored yet (null) is not the defaults stored: without a row a catalog has no price.
  const [saved, setSaved] = useState<string | null>(null);

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
        setSaved(
          snapshot(
            String(found.priceMin),
            String(found.priceMax),
            found.title ?? '',
            found.description ?? '',
            found.imageLink ?? ''
          )
        );
        setFallbackOpen(Boolean(found.title || found.description || found.imageLink));
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const minCheck = validatePrice(min);
  const maxCheck = validatePrice(max);
  const rangeOk = minCheck.ok && maxCheck.ok && minCheck.value <= maxCheck.value;
  const linkCheck = link.trim() === '' ? null : validateWebLink(link, IMAGE_LINK_MAX);
  const linkOk = linkCheck === null || linkCheck.ok;
  const titleOk = title.trim().length <= TITLE_MAX;
  const descriptionOk = description.trim().length <= DESCRIPTION_MAX;
  const valid = rangeOk && linkOk && titleOk && descriptionOk;
  const current = snapshot(min, max, title, description, link);
  const dirty = current !== saved;

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
      setSaved(current);
      push({ tone: 'success', text: t('productCatalogSettingsSaved') });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const problem: TranslationKey | null = !rangeOk
    ? 'productCatalogPriceRangeInvalid'
    : !linkOk
      ? 'productCatalogLinkInvalid'
      : null;

  return (
    <SettingsSection
      icon={DollarSign}
      titleId="product-catalog-settings-title"
      title={t('productCatalogPriceTitle')}
      description={t('productCatalogPriceDescription')}
      aside={
        rangeOk && minCheck.ok && maxCheck.ok
          ? minCheck.value === maxCheck.value
            ? `${minCheck.value} USD`
            : `${minCheck.value}–${maxCheck.value} USD`
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
          <p className="field-hint">{t('productCatalogFallbackHint')}</p>
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
        </div>
      )}
      {problem && <p className="team-inline-error">{t(problem)}</p>}
      {editable && (
        <div className="settings-section-actions">
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={!loaded || !valid || !dirty}
            onClick={() => void save()}
          >
            {t('productCatalogSettingsSave')}
          </Button>
          {loaded && dirty && valid && (
            <span className="product-catalog-unsaved">{t('productCatalogUnsaved')}</span>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
