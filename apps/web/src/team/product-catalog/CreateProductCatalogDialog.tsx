import { useEffect, useId, useState, type FormEvent } from 'react';
import type {
  ProductCatalogCreateResult,
  ProductCatalogSettings,
  ProductCatalogSummary
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { Button as InventoryButton } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { SpaceSettingsLink } from '../SpaceSettingsLink';
import { useTeam } from '../TeamContext';
import {
  PRODUCT_COUNT_DEFAULT,
  SOURCE_LINK_MAX,
  validateProductCount,
  validateWebLink
} from './limits';

export interface CreateProductCatalogClient {
  getProductCatalogSettings: (teamId: string) => Promise<ProductCatalogSettings | null>;
  createProductCatalog: (input: {
    teamId: string;
    videoMaterialId: string;
    sourceLink: string;
    productCount: number;
    replacesMaterialId: string | null;
    idempotencyKey: string;
  }) => Promise<ProductCatalogCreateResult>;
}

interface ShownCatalog {
  name: string;
  sheetUrl: string;
  productCount: number;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'busy' }
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
  video: { id: string; name: string };
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
  const titleId = useId();
  const linkId = useId();
  const countId = useId();

  const [link, setLink] = useState(replaces?.sourceLink ?? '');
  const [count, setCount] = useState(
    String(replaces?.productCount ?? initialCount ?? PRODUCT_COUNT_DEFAULT)
  );
  const [touched, setTouched] = useState({ link: false, count: false });
  const [settings, setSettings] = useState<ProductCatalogSettings | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [failure, setFailure] = useState<string | null>(null);

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
  }, [client, teamId]);

  const linkCheck = validateWebLink(link, SOURCE_LINK_MAX);
  const countCheck = validateProductCount(count);
  const settingsMissing = settings === null;
  const canConfirm = linkCheck.ok && countCheck.ok && !settingsMissing && phase.kind === 'form';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ link: true, count: true });
    if (!linkCheck.ok || !countCheck.ok || settingsMissing || phase.kind !== 'form') return;
    setPhase({ kind: 'busy' });
    setFailure(null);
    try {
      const result = await client.createProductCatalog({
        teamId,
        videoMaterialId: video.id,
        sourceLink: linkCheck.value,
        productCount: countCheck.value,
        replacesMaterialId: replaces?.id ?? null,
        // One key per confirmation: a retried request is recognised, a new attempt is not.
        idempotencyKey: `product-catalog:${crypto.randomUUID()}`
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
        <p className="product-catalog-dialog-name">{video.name}</p>

        {replaces && <p className="field-hint">{t('productCatalogRecreateNotice')}</p>}

        {settingsMissing && (
          <div className="product-catalog-dialog-missing" role="status">
            {can('manage_metadata') ? (
              <>
                <p className="team-inline-note">{t('productCatalogErrorSettingsMissing')}</p>
                <SpaceSettingsLink
                  target={{ kind: 'settings', tab: 'product-catalog' }}
                  label={t('productCatalogOpenSettings')}
                />
              </>
            ) : (
              <p className="team-inline-note">{t('productCatalogMissingSettingsNoAccess')}</p>
            )}
          </div>
        )}

        <label htmlFor={linkId}>
          <span>{t('productCatalogSourceLinkLabel')}</span>
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
        {linkError && <p className="team-inline-error">{t('productCatalogLinkInvalid')}</p>}

        <label htmlFor={countId}>
          <span>{t('productCatalogCountLabel')}</span>
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

        {busy && (
          <p className="field-hint" role="status">
            {t('productCatalogCreating')}
          </p>
        )}
        {failure && (
          <p className="team-inline-error" role="alert">
            {failure}
          </p>
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
