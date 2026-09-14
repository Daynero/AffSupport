import { useEffect, useState } from 'react';
import type { ProductCatalogSummary } from '../../api/team';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import {
  CreateProductCatalogDialog,
  type CreateProductCatalogClient
} from './CreateProductCatalogDialog';

export interface VideoProductCatalogClient extends CreateProductCatalogClient {
  getProductCatalog: (teamId: string, videoId: string) => Promise<ProductCatalogSummary | null>;
}

const defaultClient: VideoProductCatalogClient = teamApi;

/**
 * A video's catalog on its card (022): make one, or open, copy and re-create the one it has.
 *
 * Read again whenever the space's realtime revision moves, so a catalog a teammate just made
 * appears here without a reload — the same rule the transcript block follows.
 */
export function VideoProductCatalogActions({
  teamId,
  video,
  revision = 0,
  client = defaultClient
}: {
  teamId: string;
  video: { id: string; name: string };
  revision?: number;
  client?: VideoProductCatalogClient;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { activeTeam, can } = useTeam();
  const [catalog, setCatalog] = useState<ProductCatalogSummary | null | undefined>(undefined);
  const [dialog, setDialog] = useState<'create' | 'recreate' | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void client
      .getProductCatalog(teamId, video.id)
      .then(found => {
        if (active) setCatalog(found);
      })
      .catch(() => {
        if (active) setCatalog(null);
      });
    return () => {
      active = false;
    };
  }, [client, teamId, video.id, revision, reload]);

  const driveUsable = activeTeam?.connectionState === 'connected';
  const mayCreate = can('upload') && driveUsable;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      push({ tone: 'success', text: t('productCatalogLinkCopied') });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
    }
  };

  return (
    <div className="team-explorer-pane-catalog">
      <p className="team-explorer-pane-transcript-title">{t('productCatalogSection')}</p>
      {catalog === undefined ? null : catalog ? (
        <div className="product-catalog-actions">
          <Button type="button" variant="primary" onClick={() => void copy(catalog.sheetUrl)}>
            {t('productCatalogCopyLink')}
          </Button>
          <a
            className="button button-secondary"
            href={catalog.sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('productCatalogOpen')}
          </a>
          {mayCreate && (
            <Button type="button" variant="ghost" onClick={() => setDialog('recreate')}>
              {t('productCatalogRecreate')}
            </Button>
          )}
        </div>
      ) : (
        <div className="product-catalog-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={!mayCreate}
            onClick={() => setDialog('create')}
          >
            {t('productCatalogCreate')}
          </Button>
          {!driveUsable && <p className="field-hint">{t('productCatalogDriveUnavailable')}</p>}
        </div>
      )}

      {dialog && (
        <CreateProductCatalogDialog
          teamId={teamId}
          video={video}
          replaces={dialog === 'recreate' ? catalog : null}
          client={client}
          onClose={() => setDialog(null)}
          onCreated={() => setReload(value => value + 1)}
        />
      )}
    </div>
  );
}
