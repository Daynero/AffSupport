import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import {
  estimateCatalogVideoR2MonthlyUsd,
  type CatalogVideoR2Availability,
  type CatalogVideoR2Usage
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';
import { useI18n } from '../../i18n';
import { useOptionalTeam } from '../TeamContext';
import { SettingsSection } from '../workspace/SettingsSection';

function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

/**
 * «Відео в R2» beside the space tariff (050, US4): bytes against the limit, how
 * many copies are active or awaiting deletion, and a monthly estimate from the
 * public R2 prices. An estimate, never an invoice (SC-007). Drawn only when the
 * feature is available to the space or something is already stored.
 */
export function CatalogVideoR2UsageSection({
  teamId,
  client = teamApi.catalogVideoR2
}: {
  teamId: string;
  client?: CatalogVideoR2Client;
}) {
  const { t, language } = useI18n();
  const team = useOptionalTeam();
  const revision = team?.revision ?? 0;
  const updaterRevision = team?.updaterRevision ?? 0;
  const [availability, setAvailability] = useState<CatalogVideoR2Availability | null>(null);
  const [usage, setUsage] = useState<CatalogVideoR2Usage | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .availability(teamId, { signal: controller.signal })
      .then(value => setAvailability(value))
      .catch(() => setAvailability(null));
    return () => controller.abort();
  }, [client, teamId]);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .readUsage(teamId, { signal: controller.signal })
      .then(value => setUsage(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, teamId, revision, updaterRevision]);

  if (!usage || (!availability?.available && usage.usedBytes === 0 && usage.enabledCatalogs === 0))
    return null;
  const estimate = estimateCatalogVideoR2MonthlyUsd(usage.usedBytes);
  const money = (value: number) =>
    new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return (
    <SettingsSection
      icon={Film}
      titleId="team-catalog-video-r2-title"
      title={t('catalogVideoR2Usage')}
      className="catalog-video-r2-usage"
    >
      <div className="flex flex-col gap-2" data-testid="catalog-video-r2-usage">
        <p>
          {t('catalogVideoR2UsageOf', {
            used: formatBytes(usage.usedBytes, language),
            quota: formatBytes(usage.quotaBytes, language)
          })}
        </p>
        <p className="text-ink-muted">
          {t('catalogVideoR2Copies', { ready: usage.readyCopies, retiring: usage.retiringCopies })}
        </p>
        <p className="text-ink-muted">
          {estimate
            ? t('catalogVideoR2Estimate', { low: money(estimate.low), high: money(estimate.high) })
            : t('catalogVideoR2EstimateUnknown')}
        </p>
      </div>
    </SettingsSection>
  );
}
