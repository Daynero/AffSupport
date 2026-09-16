import { useEffect, useId, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import type { ProductCatalogSettings } from '../../api/team';
import { Button } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { SettingsSection } from '../workspace/SettingsSection';
import {
  DESCRIPTION_MAX,
  IMAGE_LINK_MAX,
  TITLE_MAX,
  formatPricePreview,
  validateDescription,
  validatePrice,
  validateTitle,
  validateWebLink,
  type FieldCheck
} from './limits';

export interface ProductCatalogSettingsClient {
  getProductCatalogSettings: (teamId: string) => Promise<ProductCatalogSettings | null>;
  setProductCatalogSettings: (
    teamId: string,
    input: { title: string; description: string; price: number; imageLink: string }
  ) => Promise<ProductCatalogSettings>;
}

interface Draft {
  title: string;
  description: string;
  price: string;
  imageLink: string;
}

const EMPTY: Draft = { title: '', description: '', price: '', imageLink: '' };

function draftFrom(settings: ProductCatalogSettings | null): Draft {
  return settings
    ? {
        title: settings.title,
        description: settings.description,
        price: String(settings.price),
        imageLink: settings.imageLink
      }
    : EMPTY;
}

function checks(draft: Draft) {
  return {
    title: validateTitle(draft.title),
    description: validateDescription(draft.description),
    price: validatePrice(draft.price),
    imageLink: validateWebLink(draft.imageLink, IMAGE_LINK_MAX)
  };
}

function problem<T>(check: FieldCheck<T>, invalid: TranslationKey): TranslationKey | null {
  if (check.ok) return null;
  return check.reason === 'required' ? 'productCatalogFieldRequired' : invalid;
}

/**
 * The four values every product catalog in a space is filled from (022, US2).
 *
 * Shaped like the re-stitch defaults: one panel, read-only for anyone who does not manage the
 * space, saved with one button. A field says what is wrong once it has been touched or a save
 * was tried, so an empty form does not open covered in red.
 */
export function ProductCatalogSettingsSection({
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
  const ids = {
    title: useId(),
    description: useId(),
    price: useId(),
    imageLink: useId()
  };

  const [saved, setSaved] = useState<ProductCatalogSettings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .getProductCatalogSettings(teamId)
      .then(found => {
        if (!active) return;
        setSaved(found);
        setDraft(draftFrom(found));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [teamId, client]);

  const result = checks(draft);
  const valid = result.title.ok && result.description.ok && result.price.ok && result.imageLink.ok;
  const show = (field: keyof Draft) => attempted || touched[field] === true;
  const messages: Record<keyof Draft, TranslationKey | null> = {
    title: problem(result.title, 'productCatalogTitleTooLong'),
    description: problem(result.description, 'productCatalogDescriptionTooLong'),
    price: problem(result.price, 'productCatalogPriceInvalid'),
    imageLink: problem(result.imageLink, 'productCatalogLinkInvalid')
  };

  const update = (field: keyof Draft) => (value: string) =>
    setDraft(current => ({ ...current, [field]: value }));
  const blur = (field: keyof Draft) => () => setTouched(current => ({ ...current, [field]: true }));

  const save = async () => {
    setAttempted(true);
    if (!result.title.ok || !result.description.ok || !result.price.ok || !result.imageLink.ok) {
      return;
    }
    setSaving(true);
    try {
      const next = await client.setProductCatalogSettings(teamId, {
        title: result.title.value,
        description: result.description.value,
        price: result.price.value,
        imageLink: result.imageLink.value
      });
      setSaved(next);
      setDraft(draftFrom(next));
      setTouched({});
      setAttempted(false);
      push({ tone: 'success', text: t('productCatalogSettingsSaved') });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (field: keyof Draft) => {
    const message = messages[field];
    return show(field) && message ? (
      <p className="team-inline-error" id={`${ids[field]}-error`}>
        {t(message)}
      </p>
    ) : null;
  };
  const describedBy = (field: keyof Draft, hint?: string) =>
    [hint, show(field) && messages[field] ? `${ids[field]}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <SettingsSection
      icon={FileSpreadsheet}
      titleId="product-catalog-settings-title"
      title={t('productCatalogSettingsTitle')}
      description={t('productCatalogSettingsDescription')}
      aside={
        loaded
          ? saved
            ? formatPricePreview(saved.price)
            : t('productCatalogSettingsNotSet')
          : undefined
      }
      className="product-catalog-settings"
    >
      {!editable && <p className="team-inline-note">{t('productCatalogSettingsReadOnly')}</p>}

      <div className="field-group">
        <label className="field-label" htmlFor={ids.title}>
          <span>{t('productCatalogTitleLabel')}</span>
        </label>
        <input
          id={ids.title}
          value={draft.title}
          maxLength={TITLE_MAX + 50}
          readOnly={!editable}
          aria-invalid={show('title') && messages.title !== null}
          aria-describedby={describedBy('title')}
          onChange={event => update('title')(event.target.value)}
          onBlur={blur('title')}
        />
        {fieldError('title')}
      </div>

      <div className="field-group">
        <label className="field-label" htmlFor={ids.description}>
          <span>{t('productCatalogDescriptionLabel')}</span>
        </label>
        <textarea
          id={ids.description}
          className="product-catalog-description"
          rows={4}
          value={draft.description}
          maxLength={DESCRIPTION_MAX + 50}
          readOnly={!editable}
          aria-invalid={show('description') && messages.description !== null}
          aria-describedby={describedBy('description')}
          onChange={event => update('description')(event.target.value)}
          onBlur={blur('description')}
        />
        {fieldError('description')}
      </div>

      {/* Not `settings-field-grid`: its subgrid gives a field two rows, label and control, and a
          hint or an error under the control would be drawn over it. */}
      <div className="product-catalog-settings-pair">
        <div className="field-group">
          <label className="field-label" htmlFor={ids.price}>
            <span>{t('productCatalogPriceLabel')}</span>
          </label>
          <input
            id={ids.price}
            inputMode="numeric"
            value={draft.price}
            maxLength={6}
            readOnly={!editable}
            aria-invalid={show('price') && messages.price !== null}
            aria-describedby={describedBy('price', `${ids.price}-hint`)}
            onChange={event => update('price')(event.target.value)}
            onBlur={blur('price')}
          />
          <p className="field-hint" id={`${ids.price}-hint`}>
            {t('productCatalogPriceHint', {
              price: result.price.ok ? formatPricePreview(result.price.value) : '10,00 USD'
            })}
          </p>
          {fieldError('price')}
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor={ids.imageLink}>
            <span>{t('productCatalogImageLinkLabel')}</span>
          </label>
          <input
            id={ids.imageLink}
            type="text"
            inputMode="url"
            value={draft.imageLink}
            readOnly={!editable}
            aria-invalid={show('imageLink') && messages.imageLink !== null}
            aria-describedby={describedBy('imageLink')}
            onChange={event => update('imageLink')(event.target.value)}
            onBlur={blur('imageLink')}
          />
          {fieldError('imageLink')}
        </div>
      </div>

      {editable && (
        <div className="settings-section-actions">
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={!loaded || (attempted && !valid)}
            onClick={() => void save()}
          >
            {t('productCatalogSettingsSave')}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
