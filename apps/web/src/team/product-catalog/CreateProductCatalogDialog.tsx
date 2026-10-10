import { useEffect, useId, useState, type FormEvent } from 'react';
import { Dices, Timer } from 'lucide-react';
import {
  RESTITCH_CONTRACT_VERSION,
  restitchDefaultsSaveable,
  type FinalImageDurationMode,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import type {
  ProductCatalogCreateResult,
  ProductCatalogSettings,
  ProductCatalogSummary
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox } from '../../components/ui';
import { Button as InventoryButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { useBrowserRoute } from '../../lib/navigation';
import { startTeamAgentProcess, agentCanRestitch } from '../../api/client';
import { teamApi } from '../../api/team';
import { formatMinutesInput, parseMinutesInput } from '../../components/ImageEmbeddingSection';
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
  const [randomLinkVariation, setRandomLinkVariation] = useState(true);
  const [restitchDefaults, setRestitchDefaults] = useState<TeamRestitchDefaults | null | undefined>(
    undefined
  );
  const [durationMode, setDurationMode] = useState<FinalImageDurationMode>('random-40-50');
  const [customMinutes, setCustomMinutes] = useState('45');
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
    if (!restitch) return;
    let active = true;
    setRestitchDefaults(undefined);
    void (client.getRestitchDefaults ?? teamApi.getRestitchDefaults)(teamId)
      .then(found => {
        if (!active) return;
        setRestitchDefaults(found);
        if (found) {
          setDurationMode(found.finalDurationMode);
          setCustomMinutes(formatMinutesInput(found.customFinalDurationSeconds));
        }
      })
      .catch(() => {
        if (active) setRestitchDefaults(null);
      });
    return () => {
      active = false;
    };
  }, [client, restitch, teamId]);

  const linkCheck = validateWebLink(link, SOURCE_LINK_MAX);
  const countCheck = validateProductCount(count);
  const customSeconds = parseMinutesInput(customMinutes);
  const durationValid = durationMode !== 'custom' || customSeconds !== null;
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
        const choice = JSON.stringify({ durationMode, customSeconds, defaults });
        if (processed?.choice === choice) {
          restitchOperationId = processed.operationId;
          catalogKey = processed.catalogKey;
        } else {
          const available = await (client.canRestitch ?? agentCanRestitch)();
          if (available !== 'yes') throw new Error('AGENT_UPDATE_REQUIRED');
          // Drive pools (030) or the owner's published library (legacy): the settings say which.
          const drawn = await (client.prepareRestitchScreens ?? prepareRestitchScreens)(
            teamId,
            defaults
          );
          if (drawn.kind === 'too-old') throw new Error('AGENT_UPDATE_REQUIRED');
          if (drawn.kind === 'legacy') {
            await (client.ensureRestitchImages ?? ensureRestitchImages)(teamId, defaults);
          }
          const destination = await (
            client.ensureRestitchedFolder ?? teamApi.ensureRestitchedFolder
          )(teamId);
          const stem = video.name.replace(/\.[^.]+$/u, '') || video.name;
          const started = await (client.startProcess ?? teamApi.startProcess)({
            teamId,
            materialId: video.id,
            toolId: 'restitch',
            optionsSummary: { finalDurationMode: durationMode },
            destinationFolderId: destination.materialId,
            outputName: `${stem} restitched.mp4`,
            conflictMode: 'keep_both',
            idempotencyKey: crypto.randomUUID(),
            agentContractVersion: 1,
            toolContractVersion: RESTITCH_CONTRACT_VERSION
          });
          try {
            const finished = await (client.runAgentProcess ?? startTeamAgentProcess)({
              operationId: started.operationId,
              toolId: 'restitch',
              options: {
                defaults: {
                  ...defaults,
                  operation: 'restitch',
                  finalDurationMode: durationMode,
                  customFinalDurationSeconds:
                    durationMode === 'custom' ? customSeconds! : defaults.customFinalDurationSeconds
                },
                prepared: null,
                ...(drawn.kind === 'ready' ? { screens: drawn.screens, teamId } : {})
              },
              sourceGrant: started.sourceGrant,
              finalizeGrant: started.finalizeGrant
            });
            if (finished.state !== 'succeeded' || !finished.materialId)
              throw new Error('PROCESS_FAILED');
            restitchOperationId = started.operationId;
            setProcessed({ operationId: started.operationId, choice, catalogKey });
          } catch (error) {
            await (client.cancelOperation ?? teamApi.cancelOperation)(
              teamId,
              started.operationId
            ).catch(() => undefined);
            throw error;
          }
        }
        setPhase({ kind: 'busy', step: 'catalog' });
      }
      const result = await client.createProductCatalog({
        teamId,
        videoMaterialId: video.id,
        sourceLink: linkCheck.value,
        productCount: countCheck.value,
        randomLinkVariation,
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
    >
      <form
        noValidate
        className="team-dialog-form product-catalog-dialog"
        onSubmit={event => void submit(event)}
      >
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
            <p className="product-catalog-dialog-name" title={video.name}>
              {plannedName}
            </p>
            <InventoryButton
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t('productCatalogCopyNameOf', { name: plannedName })}
              onClick={() => void copy(plannedName, 'productCatalogNameCopied')}
            >
              {t('productCatalogCopyName')}
            </InventoryButton>
          </div>
        ) : (
          <p className="product-catalog-dialog-name">{video.name}</p>
        )}

        {replaces && <p className="field-hint">{t('productCatalogRecreateNotice')}</p>}

        {settings === null && !can('manage_metadata') && (
          <p className="team-inline-note">{t('productCatalogMissingSettingsNoAccess')}</p>
        )}

        <label htmlFor={linkId}>
          <span>
            {t('productCatalogSourceLinkLabel')} · {t('productCatalogRequiredLabel')}
          </span>
          <input
            id={linkId}
            type="text"
            inputMode="url"
            autoComplete="off"
            value={link}
            disabled={busy}
            aria-invalid={linkError}
            onChange={event => setLink(event.target.value)}
            onBlur={() => setTouched(current => ({ ...current, link: true }))}
          />
        </label>
        {linkError ? (
          <p className="team-inline-error">{t('productCatalogLinkInvalid')}</p>
        ) : (
          <p className="field-hint">{t('productCatalogSourceLinkHint')}</p>
        )}

        <label htmlFor={countId}>
          <span>
            {t('productCatalogCountLabel')} · {t('productCatalogRequiredLabel')}
          </span>
          <input
            id={countId}
            className="product-catalog-count"
            inputMode="numeric"
            maxLength={3}
            value={count}
            disabled={busy}
            aria-invalid={countError}
            onChange={event => setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))}
            onBlur={() => setTouched(current => ({ ...current, count: true }))}
          />
        </label>
        <p className={countError ? 'team-inline-error' : 'field-hint'}>
          {t(countError ? 'productCatalogCountInvalid' : 'productCatalogCountHint')}
        </p>

        <div className="product-catalog-restitch">
          <Checkbox
            checked={randomLinkVariation}
            disabled={busy}
            onChange={event => setRandomLinkVariation(event.target.checked)}
            label={t('catalogRandomLinkVariation')}
          />
        </div>

        <div className="product-catalog-restitch">
          <Checkbox
            checked={restitch}
            disabled={busy}
            onChange={event => {
              setRestitch(event.target.checked);
              setProcessed(null);
            }}
            label={t('productCatalogRestitch')}
          />
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
              <div className="start-duration-row">
                <div className="fit-mode-pictos" role="group" aria-label={t('finalImageDuration')}>
                  {(
                    [
                      ['random-30-40', 'randomDuration30To40', '30–40'],
                      ['random-40-50', 'randomDuration40To50', '40–50'],
                      ['random-50-60', 'randomDuration50To60', '50–60']
                    ] as const
                  ).map(([mode, label, range]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`is-labeled${durationMode === mode ? ' is-selected' : ''}`}
                      disabled={busy}
                      data-tip={t(label)}
                      title={t(label)}
                      aria-label={t(label)}
                      aria-pressed={durationMode === mode}
                      onClick={() => setDurationMode(mode)}
                    >
                      <Dices size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      <span>{range}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={durationMode === 'custom' ? 'is-selected' : ''}
                    disabled={busy}
                    data-tip={t('customDuration')}
                    title={t('customDuration')}
                    aria-label={t('customDuration')}
                    aria-pressed={durationMode === 'custom'}
                    onClick={() => setDurationMode('custom')}
                  >
                    <Timer size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </button>
                </div>
                {durationMode === 'custom' && (
                  <div className="custom-duration-input">
                    <input
                      className={`time-input${customMinutes && !durationValid ? ' is-invalid' : ''}`}
                      type="text"
                      inputMode="numeric"
                      value={customMinutes}
                      disabled={busy}
                      aria-label={t('customDurationInput')}
                      aria-invalid={customMinutes !== '' && !durationValid}
                      onChange={event => setCustomMinutes(event.target.value)}
                    />
                    <span>{t('minutesUnit')}</span>
                  </div>
                )}
                {customMinutes !== '' && !durationValid && (
                  <span className="soty-field-error">{t('invalidCustomDuration')}</span>
                )}
              </div>
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
