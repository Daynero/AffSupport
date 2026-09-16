import { useState, type FormEvent } from 'react';
import type {
  CatalogMaterialItem,
  CatalogVocabulary,
  MaterialMetadataPatch
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { Button, ErrorState, FormField, Input, Select } from '../../components/ui/index';

export function MaterialMetadataEditor({
  material,
  vocabulary,
  onClose,
  onSave
}: {
  material: CatalogMaterialItem;
  vocabulary: CatalogVocabulary;
  onClose: () => void;
  onSave: (patch: MaterialMetadataPatch) => Promise<void>;
}) {
  const { t } = useI18n();
  const [geo, setGeo] = useState(material.geo ?? '');
  const [language, setLanguage] = useState(material.language ?? '');
  const [offer, setOffer] = useState(material.offer ?? '');
  const [tags, setTags] = useState(material.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      await onSave({
        geo: geo || null,
        language: language || null,
        offer: offer || null,
        tags: tags
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean)
      });
      onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      labelledBy="material-metadata-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#material-geo"
      size="md"
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h2 id="material-metadata-title">{t('teamCatalogMetadataTitle')}</h2>
        <p>{material.name}</p>
        <FormField label={t('teamCatalogMaterialGeo')}>
          <Select
            id="material-geo"
            aria-label={t('teamCatalogMaterialGeo')}
            value={geo}
            placeholder={t('teamCatalogUnfilled')}
            options={vocabulary.geo.map(value => ({ value, label: value }))}
            onChange={setGeo}
          />
        </FormField>
        <FormField label={t('teamCatalogMaterialLanguage')}>
          <Select
            aria-label={t('teamCatalogMaterialLanguage')}
            value={language}
            placeholder={t('teamCatalogUnfilled')}
            options={vocabulary.languages.map(value => ({ value, label: value }))}
            onChange={setLanguage}
          />
        </FormField>
        <FormField label={t('teamCatalogMaterialOffer')}>
          <Input
            aria-label={t('teamCatalogMaterialOffer')}
            value={offer}
            maxLength={160}
            onChange={event => setOffer(event.target.value)}
          />
        </FormField>
        <FormField label={t('teamCatalogMaterialTags')}>
          <Input
            aria-label={t('teamCatalogMaterialTags')}
            value={tags}
            onChange={event => setTags(event.target.value)}
          />
        </FormField>
        {error && (
          <ErrorState className="team-inline-error" message={t('teamCatalogMetadataFailed')} />
        )}
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('teamCatalogSaveMetadata')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
