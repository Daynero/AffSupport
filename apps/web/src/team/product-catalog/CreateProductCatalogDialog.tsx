import { prepareCatalogRestitch } from './catalog-orchestration';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { restitchDefaultsSaveable, type TeamRestitchDefaults } from '@video-compressor/shared';
import type {
  ProductCatalogCreateResult,
  ProductCatalogSettings,
  ProductCatalogSummary
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox } from '../../components/ui';
import {
  Button as InventoryButton,
  IconButton,
  Skeleton,
  RestitchDurationControl,
  type RestitchDurationValue
} from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { useBrowserRoute } from '../../lib/navigation';
import { startTeamAgentProcess, agentCanRestitch } from '../../api/client';
import { teamApi } from '../../api/team';
import { teamErrorMessageFor } from '../errors';
import { SpaceSettingsLink } from '../SpaceSettingsLink';
import { useTeam } from '../TeamContext';
import { parseTeamRoute } from '../routes';
import { productCatalogNameFor } from '../materials/tail';
import {
  PRODUCT_COUNT_DEFAULT,
  SOURCE_LINK_MAX,
  validateProductCount,
  validateWebLink
} from './limits';
import { useOptionalAuth } from '../../auth/AuthContext';
import {
  catalogDurationPreferenceKey,
  readCatalogDurationPreference,
  saveCatalogDurationPreference
} from './duration-preference';
import { ProductCatalogProgress } from './ProductCatalogProgress';
import { PRICE_RANGE_DEFAULT } from './ProductCatalogSettingsSection';
import { ensureRestitchImages } from '../restitch/images';
import { prepareRestitchScreens } from '../restitch/screens';

export interface CreateProductCatalogClient {
  getProductCatalogSettings: (teamId: string) => Promise<ProductCatalogSettings | null>;
  setProductCatalogSettings?: typeof teamApi.setProductCatalogSettings;
  getRestitchDefaults?: (teamId: string) => Promise<TeamRestitchDefaults | null>;
  startProcess?: typeof teamApi.startProcess;
  runAgentProcess?: typeof startTeamAgentProcess;
  canRestitch?: typeof agentCanRestitch;
  ensureRestitchImages?: typeof ensureRestitchImages;
  /** 030: the pictures drawn from the space, in place of the published library. */
  prepareRestitchScreens?: typeof prepareRestitchScreens;
  ensureRestitchedFolder?: typeof teamApi.ensureRestitchedFolder;
  cancelOperation?: typeof teamApi.cancelOperation;
  createProductCatalog: (input: {
    teamId: string;
    videoMaterialId: string;
    sourceLink: string;
    productCount: number;
    randomLinkVariation?: boolean;
    replacesMaterialId: string | null;
    restitchOperationId?: string | null;
    idempotencyKey: string;
  }) => Promise<ProductCatalogCreateResult>;
  /** The number the next variation will take, so its name shows before it is made (024). */
  nextProductCatalogVariant?: (teamId: string, videoMaterialId: string) => Promise<number>;
}

interface ShownCatalog {
  name: string;
  sheetUrl: string;
  productCount: number;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'busy'; step: 'restitch' | 'catalog' }
  | { kind: 'result'; heading: TranslationKey; catalog: ShownCatalog };

function errorKey(error: unknown): TranslationKey | null {
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  const code = (error as { code?: unknown } | null)?.code;
  if (details?.reason === 'settings_missing') return 'productCatalogErrorSettingsMissing';
  if (details?.reason === 'not_a_video') return 'productCatalogErrorNotVideo';
  if (details?.field === 'link') return 'productCatalogLinkInvalid';
  if (details?.field === 'count') return 'productCatalogCountInvalid';
  if (code === 'SHARE_NOT_ALLOWED') return 'productCatalogErrorShare';
  return null;
}

/**
 * "Create catalog" (022, US1 and US5): a link and a product count, then the sheet.
 *
 * Re-creating is the same form prefilled with what that variation was made from, saying once
 * that it will be replaced. The result leads with the sheet's name and a button that copies it:
 * the owner names the catalog on Meta the same way (024, US15), and retyping `IN 40_v2_catalog`
 * is where the two start to disagree. There is no warning about the links being viewable: the
 * pasted link and the sheet belong to the person making them.
 */
export function CreateProductCatalogDialog({
  teamId,
  video,
  replaces,
  variation = false,
  initialCount,
  client,
  onClose,
  onCreated
}: {
  teamId: string;
  video: { id: string; name: string; parentFolderId?: string | null };
  /** The variation being replaced; absent to create one. */
  replaces?: ProductCatalogSummary | null;
  /** The video already has catalogs, so this one is a new variation beside them. */
  variation?: boolean;
  /** The count to start from — the last variation's, so a second one is one link away. */
  initialCount?: number;
  client: CreateProductCatalogClient;
  onClose: () => void;
  onCreated?: (result: ProductCatalogCreateResult) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const preferenceKey = catalogDurationPreferenceKey(useOptionalAuth()?.user?.id ?? null, teamId);
  const durationPreference = useRef<{
    key: string | null;
    value: RestitchDurationValue | null;
  } | null>(null);
  const route = parseTeamRoute(useBrowserRoute());
  const settingsOpen = route?.kind === 'space' && route.query.settings;
  const titleId = useId();
  const linkId = useId();
  const countId = useId();

  const [link, setLink] = useState(replaces?.sourceLink ?? '');
  const [count, setCount] = useState(
    String(replaces?.productCount ?? initialCount ?? PRODUCT_COUNT_DEFAULT)
  );
  const [touched, setTouched] = useState({ link: false, count: false });
  const [settings, setSettings] = useState<ProductCatalogSettings | null | undefined>(undefined);
  const [restitch, setRestitch] = useState(false);
  // Once requested, a read belongs to this dialog, not to the checkbox's visibility.
  const [restitchRequested, setRestitchRequested] = useState(false);
  const [restitchLoadError, setRestitchLoadError] = useState(false);
  const [restitchReadRevision, setRestitchReadRevision] = useState(0);
  const getRestitchDefaults = client.getRestitchDefaults ?? teamApi.getRestitchDefaults;
  const [restitchDefaults, setRestitchDefaults] = useState<TeamRestitchDefaults | null | undefined>(
    undefined
  );
  const [duration, setDuration] = useState<RestitchDurationValue>({
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: 45 * 60
  });
  const [processed, setProcessed] = useState<{
    operationId: string;
    choice: string;
    catalogKey: string;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [failure, setFailure] = useState<string | null>(null);
  /** The refusal was "no catalog settings yet": the way to fix it goes right under it. */
  const [failureNeedsSettings, setFailureNeedsSettings] = useState(false);
  /*
   * The name the sheet will have, up front (024): it is what the owner types on Meta, and the
   * form used to show it only after the catalog existed. Re-creating keeps its number.
   */
  const [plannedVariant, setPlannedVariant] = useState<number | null>(replaces?.variant ?? null);
  useEffect(() => {
    if (replaces || !client.nextProductCatalogVariant) return;
    let active = true;
    void client
      .nextProductCatalogVariant(teamId, video.id)
      .then(value => {
        if (active) setPlannedVariant(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, replaces, teamId, video.id]);
  const plannedName = plannedVariant ? productCatalogNameFor(video.name, plannedVariant) : null;

  useEffect(() => {
    let active = true;
    void client
      .getProductCatalogSettings(teamId)
      .then(found => {
        if (active) setSettings(found);
      })
      .catch(() => {
        // Unknown is not "missing": the server still refuses a space without settings.
        if (active) setSettings(undefined);
      });
    return () => {
      active = false;
    };
  }, [client, teamId, settingsOpen]);

  useEffect(() => {
    if (!durationPreference.current || durationPreference.current.key !== preferenceKey) {
      durationPreference.current = {
        key: preferenceKey,
        value: readCatalogDurationPreference(preferenceKey)
      };
    }
    if (!restitchRequested || settingsOpen) return;
    let active = true;
    setRestitchLoadError(false);
    setRestitchDefaults(undefined);
    void getRestitchDefaults(teamId)
      .then(found => {
        if (!active) return;
        setRestitchDefaults(found);
        if (found) {
          setDuration(
            durationPreference.current?.value ?? {
              finalDurationMode: found.finalDurationMode,
              customFinalDurationSeconds:
                Math.max(1, Math.round(found.customFinalDurationSeconds / 60)) * 60
            }
          );
        }
      })
      .catch(() => {
        if (active) setRestitchLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [
    getRestitchDefaults,
    restitchRequested,
    teamId,
    preferenceKey,
    settingsOpen,
    restitchReadRevision
  ]);

  const linkCheck = validateWebLink(link, SOURCE_LINK_MAX);
  const countCheck = validateProductCount(count);
  const durationMode = duration.finalDurationMode;
  const customSeconds = duration.customFinalDurationSeconds ?? null;
  const durationValid =
    (durationMode !== 'custom' && durationMode !== 'random-centered') ||
    (customSeconds !== null &&
      Number.isInteger(customSeconds) &&
      customSeconds >= 60 &&
      customSeconds <= 3600);
  const canConfirm =
    linkCheck.ok &&
    countCheck.ok &&
    settings !== undefined &&
    (settings !== null || can('manage_metadata')) &&
    (!restitch ||
      (restitchDefaults !== undefined &&
        restitchDefaults !== null &&
        restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' }) &&
        durationValid)) &&
    phase.kind === 'form';

  /*
   * The server's own steps, in its own order (`drive-ops/product-catalog.ts`):
   * prove the video and open it by link, draw texts and pictures, open every
   * picture by link — one Drive call each, which is where a catalog of fifty
   * spends its time — build the sheet, upload and convert it, register it. The
   * per-picture stage is sized by the count; the last stage waits for the answer.
   */
  const productTotal = countCheck.ok ? countCheck.value : 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ link: true, count: true });
    if (!linkCheck.ok || !countCheck.ok || !canConfirm || phase.kind !== 'form') return;
    setPhase({ kind: 'busy', step: restitch ? 'restitch' : 'catalog' });
    setFailure(null);
    setFailureNeedsSettings(false);
    try {
      // The displayed price range is a usable default even before anyone has saved settings.
      if (settings === null) {
        const saved = await (client.setProductCatalogSettings ?? teamApi.setProductCatalogSettings)(
          teamId,
          {
            title: null,
            description: null,
            imageLink: null,
            priceMin: PRICE_RANGE_DEFAULT.min,
            priceMax: PRICE_RANGE_DEFAULT.max
          }
        );
        setSettings(saved);
      }
      let restitchOperationId: string | null = null;
      let catalogKey = `product-catalog:${crypto.randomUUID()}`;
      if (restitch) {
        const defaults = restitchDefaults;
        if (!defaults) throw new Error('RESTITCH_DEFAULTS_INVALID');
        const receipt = await prepareCatalogRestitch({
          teamId,
          video,
          defaults,
          durationMode,
          customSeconds,
          durationRangeSeconds: duration.finalDurationRangeSeconds,
          catalogKey,
          previous: processed,
          client
        });
        restitchOperationId = receipt.operationId;
        catalogKey = receipt.catalogKey;
        setProcessed(receipt);
        setPhase({ kind: 'busy', step: 'catalog' });
      }
      const result = await client.createProductCatalog({
        teamId,
        videoMaterialId: video.id,
        sourceLink: linkCheck.value,
        productCount: countCheck.value,
        randomLinkVariation: true,
        replacesMaterialId: replaces?.id ?? null,
        ...(restitchOperationId ? { restitchOperationId } : {}),
        // A retry after the video finished must reuse the same catalog operation.
        idempotencyKey: catalogKey
      });
      setPhase({
        kind: 'result',
        heading:
          result.outcome === 'existing' ? 'productCatalogAlreadyExists' : 'productCatalogReady',
        catalog: result.catalog
      });
      onCreated?.(result);
    } catch (error) {
      const key = errorKey(error);
      setFailure(key ? t(key) : teamErrorMessageFor(error, t));
      setFailureNeedsSettings(key === 'productCatalogErrorSettingsMissing');
      setPhase({ kind: 'form' });
    }
  };

  const copy = async (text: string, done: TranslationKey = 'productCatalogLinkCopied') => {
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: 'success', text: t(done) });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
    }
  };

  if (phase.kind === 'result') {
    const shown = phase.catalog;
    return (
      <Modal labelledBy={titleId} onClose={onClose} closeLabel={t('productCatalogDone')} size="md">
        <div className="team-dialog-form product-catalog-dialog">
          <h2 id={titleId}>{t(phase.heading)}</h2>
          <div className="product-catalog-dialog-name-row">
            <p className="product-catalog-dialog-name">{shown.name}</p>
            <InventoryButton
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t('productCatalogCopyNameOf', { name: shown.name })}
              onClick={() => void copy(shown.name, 'productCatalogNameCopied')}
            >
              {t('productCatalogCopyName')}
            </InventoryButton>
          </div>
          <p className="field-hint">{t('productCatalogProducts', { count: shown.productCount })}</p>
          <div className="team-dialog-actions">
            <a
              className="soty-button button-secondary"
              href={shown.sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('productCatalogOpen')}
            >
              {t('productCatalogOpenShort')}
            </a>
            <Button
              type="button"
              variant="secondary"
              aria-label={t('productCatalogCopyLink')}
              onClick={() => void copy(shown.sheetUrl)}
            >
              {t('productCatalogCopyLinkShort')}
            </Button>
            <Button type="button" variant="primary" onClick={onClose}>
              {t('productCatalogDone')}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const busy = phase.kind === 'busy';
  // An empty field is not a mistake yet — Create simply waits for it. The dialog opened with
  // "Paste a link that starts with http://" in red before anything had been typed.
  const linkError = touched.link && link.trim() !== '' && !linkCheck.ok;
  const countError = touched.count && !countCheck.ok;

  return (
    <Modal
      labelledBy={titleId}
      onClose={busy ? () => undefined : onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeLabel={t('productCatalogCancel')}
      initialFocus={`[id="${linkId}"]`}
      size="md"
      className="product-catalog-create-surface"
    >
      <form
        noValidate
        className="team-dialog-form product-catalog-dialog"
        onSubmit={event => void submit(event)}
      >
        <header className="product-catalog-create-header">
          <h2 id={titleId}>
            {t(
              replaces
                ? 'productCatalogRecreate'
                : variation
                  ? 'productCatalogCreateVariation'
                  : 'productCatalogCreate'
            )}
          </h2>
          {plannedName ? (
            <div className="product-catalog-dialog-name-row">
              <p className="product-catalog-dialog-name" title={plannedName}>
                {plannedName}
              </p>
              <IconButton
                size="sm"
                variant="outline"
                label={t('productCatalogCopyNameOf', { name: plannedName })}
                title={t('productCatalogCopyName')}
                onClick={() => void copy(plannedName, 'productCatalogNameCopied')}
              >
                <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <p className="product-catalog-dialog-name">{video.name}</p>
          )}
        </header>
        <div className="product-catalog-create-body">
          {replaces && <p className="field-hint">{t('productCatalogRecreateNotice')}</p>}

          {settings === null && !can('manage_metadata') && (
            <p className="team-inline-note">{t('productCatalogMissingSettingsNoAccess')}</p>
          )}

          <div className="product-catalog-create-fields">
            <div className="product-catalog-link-field">
              <label htmlFor={linkId}>
                <span>{t('productCatalogSourceLinkLabel')}</span>
                <input
                  id={linkId}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  required
                  value={link}
                  placeholder={t('productCatalogSourceLinkPlaceholder')}
                  disabled={busy}
                  aria-invalid={linkError}
                  aria-describedby={`${linkId}-help`}
                  onChange={event => setLink(event.target.value)}
                  onBlur={() => setTouched(current => ({ ...current, link: true }))}
                />
              </label>
              <p
                id={`${linkId}-help`}
                className={linkError ? 'team-inline-error' : 'sr-only'}
                role={linkError ? 'alert' : undefined}
              >
                {t(linkError ? 'productCatalogLinkInvalid' : 'productCatalogSourceLinkHint')}
              </p>
            </div>
            <div className="product-catalog-count-field">
              <label htmlFor={countId}>
                <span>
                  {t('productCatalogCountLabel')}{' '}
                  <span className="product-catalog-count-limit" aria-hidden="true">
                    1–400
                  </span>
                </span>
                <input
                  id={countId}
                  className="product-catalog-count"
                  inputMode="numeric"
                  required
                  maxLength={3}
                  value={count}
                  disabled={busy}
                  aria-invalid={countError}
                  aria-describedby={`${countId}-help`}
                  onChange={event =>
                    setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))
                  }
                  onBlur={() => setTouched(current => ({ ...current, count: true }))}
                />
              </label>
              <p
                id={`${countId}-help`}
                className={countError ? 'team-inline-error' : 'sr-only'}
                role={countError ? 'alert' : undefined}
              >
                {t(countError ? 'productCatalogCountInvalid' : 'productCatalogCountHint')}
              </p>
            </div>
          </div>

          <div className="product-catalog-restitch">
            <Checkbox
              checked={restitch}
              disabled={busy}
              onChange={event => {
                setRestitch(event.target.checked);
                if (event.target.checked) setRestitchRequested(true);
                setProcessed(null);
              }}
              label={t('productCatalogRestitch')}
            />
            {restitch && restitchDefaults === undefined && !restitchLoadError && (
              <Skeleton
                className="product-catalog-restitch-loading"
                shape="block"
                label={t('loading')}
              />
            )}
            {restitch && restitchLoadError && (
              <div className="product-catalog-dialog-missing" role="alert">
                <p className="team-inline-note">{t('productCatalogRestitchLoadFailed')}</p>
                <InventoryButton
                  size="sm"
                  variant="outline"
                  onClick={() => setRestitchReadRevision(value => value + 1)}
                >
                  {t('retry')}
                </InventoryButton>
              </div>
            )}
            {restitch &&
              restitchDefaults !== undefined &&
              (!restitchDefaults ||
                !restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' })) && (
                <div className="product-catalog-dialog-missing" role="status">
                  <p className="team-inline-note">{t('teamRestitchNotConfigured')}</p>
                  <SpaceSettingsLink
                    target={{ kind: 'settings', tab: 'restitch' }}
                    label={t('productCatalogOpenSettings')}
                  />
                </div>
              )}
            {restitch &&
              restitchDefaults &&
              restitchDefaultsSaveable({ ...restitchDefaults, operation: 'restitch' }) && (
                <RestitchDurationControl
                  value={duration}
                  disabled={busy}
                  labels={{
                    duration: t('launchesDuration'),
                    range: t('launchesDurationRange'),
                    exact: t('launchesDurationExact'),
                    unit: t('launchesMinutesShort')
                  }}
                  onChange={value => {
                    durationPreference.current = { key: preferenceKey, value };
                    setDuration(value);
                    saveCatalogDurationPreference(preferenceKey, value);
                  }}
                />
              )}
            {restitch && restitchDefaults && !durationValid && (
              <p className="team-inline-error" role="alert">
                {t('launchesDurationInvalid')}
              </p>
            )}
          </div>

          {phase.kind === 'busy' && phase.step === 'restitch' && (
            <p className="field-hint" role="status">
              {t('productCatalogRestitching')}
            </p>
          )}
          <ProductCatalogProgress
            active={phase.kind === 'busy' && phase.step === 'catalog'}
            productTotal={productTotal}
          />
          {failure && (
            <p className="team-inline-error" role="alert">
              {failure}
            </p>
          )}
          {failure && failureNeedsSettings && can('manage_metadata') && (
            <SpaceSettingsLink
              target={{ kind: 'settings', tab: 'product-catalog' }}
              label={t('productCatalogOpenSettings')}
            />
          )}
        </div>
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t('productCatalogCancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canConfirm}>
            {t(replaces ? 'productCatalogRecreateConfirm' : 'productCatalogConfirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
