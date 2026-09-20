import { useEffect, useState } from 'react';
import type { ProductCatalogSummary } from '../../api/team';
import { teamApi } from '../../api/team';
import { CreateProductCatalogDialog } from './CreateProductCatalogDialog';
import type { VideoProductCatalogClient } from './VideoProductCatalogActions';

const defaultClient: VideoProductCatalogClient = teamApi;

/**
 * "Catalog" from a video's row menu (022, US3).
 *
 * The menu cannot hold a dialog — it unmounts the moment it closes — so the explorer shell
 * renders this instead. It reads the video's catalog first and opens on it when there is one,
 * or straight on "Create catalog" when there is not, so the entry needs no state of its own.
 */
export function ProductCatalogMenuDialog({
  teamId,
  video,
  client = defaultClient,
  onClose,
  onChanged
}: {
  teamId: string;
  video: { id: string; name: string };
  client?: VideoProductCatalogClient;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [catalog, setCatalog] = useState<ProductCatalogSummary | null | undefined>(undefined);

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
  }, [client, teamId, video.id]);

  if (catalog === undefined) return null;
  return (
    <CreateProductCatalogDialog
      teamId={teamId}
      video={video}
      existing={catalog}
      client={client}
      onClose={onClose}
      onCreated={() => onChanged?.()}
    />
  );
}
