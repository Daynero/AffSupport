import { useEffect, useState } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';

export interface MaterialCatalogFactsClient {
  listTeamProductCatalogs?: (teamId: string) => Promise<CatalogRegistryRow[]>;
}

/** A sheet Soty made: `clip_v2_catalog`. Anything else is not worth a read of the registry. */
export const isCatalogSheetName = (name: string) => /_v\d+_catalog$/iu.test(name.trim());

/**
 * What a catalog sheet is, in its card (024, US23).
 *
 * Selected in Files, a catalog said "Google document, opens in Google Drive" and nothing else —
 * not which video it sells, not how many products it holds, not whether anything updates it. The
 * registry knows all three; this reads it for the one file that is open and says so in a line,
 * with the way to the updater beside it.
 */
export function MaterialCatalogFacts({
  teamId,
  material,
  client = teamApi
}: {
  teamId: string;
  material: { id: string; name: string };
  client?: MaterialCatalogFactsClient;
}) {
  const { t, language } = useI18n();
  const [row, setRow] = useState<CatalogRegistryRow | null>(null);

  useEffect(() => {
    if (!client.listTeamProductCatalogs || !isCatalogSheetName(material.name)) {
      setRow(null);
      return;
    }
    let active = true;
    void client
      .listTeamProductCatalogs(teamId)
      .then(rows => {
        if (active) setRow(rows.find(entry => entry.catalogId === material.id) ?? null);
      })
      .catch(() => {
        if (active) setRow(null);
      });
    return () => {
      active = false;
    };
  }, [client, material.id, material.name, teamId]);

  if (!row) return null;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(language === 'uk' ? 'uk-UA' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  const href = `${window.location.pathname}?updater=1`;

  return (
    <div className="material-catalog-facts">
      <p>{t('materialCatalogOfVideo', { name: row.videoName.trim() })}</p>
      <p>
        {t('materialCatalogProducts', { count: row.productCount })}
        {' · '}
        {row.lastUpdatedAt
          ? t('materialCatalogUpdated', { when: when(row.lastUpdatedAt) })
          : t('materialCatalogNeverUpdated')}
      </p>
      <a
        href={href}
        onClick={event => {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          navigateTo(href);
        }}
      >
        {t('materialCatalogOpenUpdater')}
      </a>
    </div>
  );
}
