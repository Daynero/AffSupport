import { useState, type FormEvent } from 'react';
import type {
  CatalogMaterialItem,
  CatalogVocabulary,
  MaterialMetadataPatch
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

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
        <label>
          <span>{t('teamCatalogMaterialGeo')}</span>
          <select id="material-geo" value={geo} onChange={event => setGeo(event.target.value)}>
            <option value="">{t('teamCatalogUnfilled')}</option>
            {vocabulary.geo.map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('teamCatalogMaterialLanguage')}</span>
          <select value={language} onChange={event => setLanguage(event.target.value)}>
            <option value="">{t('teamCatalogUnfilled')}</option>
            {vocabulary.languages.map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('teamCatalogMaterialOffer')}</span>
          <input value={offer} maxLength={160} onChange={event => setOffer(event.target.value)} />
        </label>
        <label>
          <span>{t('teamCatalogMaterialTags')}</span>
          <input value={tags} onChange={event => setTags(event.target.value)} />
        </label>
        {error && <p className="team-inline-error">{t('teamCatalogMetadataFailed')}</p>}
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
