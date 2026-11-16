import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
import { Alert } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useLegacyCatalogImageSettings, useOptionalTeam } from '../TeamContext';
import {
  ProductCatalogImagesSettings,
  type CatalogImagesSettingsClient
} from '../product-catalog/ProductCatalogSettingsSection';
import {
  CatalogDefaultsEditor,
  type CatalogDefaultsClient
} from '../catalog-updater/CatalogDefaultsEditor';

export type CatalogSettingsClient = CatalogImagesSettingsClient & CatalogDefaultsClient;

type DraftState = { dirty: boolean; saving: boolean };
const IDLE: DraftState = { dirty: false, saving: false };

/**
 * The Catalog tab of space settings: the space's own pictures, and how new catalogs update.
 *
 * 055 retired the names, descriptions and prices that used to fill this tab — they are made per
 * picture now — and removed the tab with them. The pictures and the update defaults were not
 * retired, so they come back here, and only they do.
 *
 * Where the shared image pool serves the space there is nothing of its own to upload, so the
 * gallery gives way to one line saying where the pictures come from. While the policy is still
 * being read neither is shown: a gallery that vanishes a second later, or a note that turns out
 * wrong, is worse than a moment of nothing.
 */
export function CatalogSettingsSection({
  teamId,
  client,
  onDraftChange
}: {
  teamId: string;
  client: CatalogSettingsClient;
  /** Whether leaving now would lose a draft or interrupt an upload. */
  onDraftChange?: (state: DraftState) => void;
}) {
  const { t } = useI18n();
  const ownImages = useLegacyCatalogImageSettings();
  const policyKnown = Boolean(useOptionalTeam()?.globalImagePolicy);
  const [open, setOpen] = useState('');
  const [imagesBusy, setImagesBusy] = useState(false);
  const [defaults, setDefaults] = useState<DraftState>(IDLE);
  const uploading = ownImages && imagesBusy;
  useEffect(() => {
    onDraftChange?.({ dirty: defaults.dirty, saving: defaults.saving || uploading });
  }, [defaults, uploading, onDraftChange]);
  useEffect(() => () => onDraftChange?.(IDLE), [onDraftChange]);

  return (
    <div className="catalog-settings-overview">
      {ownImages ? (
        <ProductCatalogImagesSettings
          key={teamId}
          teamId={teamId}
          client={client}
          open={open}
          onOpenChange={setOpen}
          onBusyChange={setImagesBusy}
        />
      ) : (
        policyKnown && (
          <Alert
            color="neutral"
            variant="subtle"
            icon={<Image size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            title={t('catalogImagesTitle')}
          >
            {t('catalogImagesSharedPoolNote')}
          </Alert>
        )
      )}
      <CatalogDefaultsEditor
        teamId={teamId}
        client={client}
        open={open === 'rules'}
        onOpenChange={next => setOpen(next ? 'rules' : '')}
        onDraftChange={setDefaults}
      />
    </div>
  );
}
