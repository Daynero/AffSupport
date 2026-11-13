import {
  launchNamingPreview,
  type LaunchDraft,
  type LaunchSourceSnapshot
} from '@video-compressor/shared';
import { Badge, Card } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { CopyResultField } from './CopyResultField.js';

/** A preview is never a revision, a publication receipt or proof of result delivery. */
export function LaunchPendingResult({
  config,
  sources,
  catalogName,
  onCopied,
  onCopyOutcome
}: {
  config: LaunchDraft;
  sources: LaunchSourceSnapshot | null;
  catalogName?: string | null;
  onCopied?: (field: string, value: string) => void;
  onCopyOutcome?: (field: 'catalog_name' | 'campaign_name', outcome: 'success' | 'failure') => void;
}) {
  const { t } = useI18n();
  const campaigns = launchNamingPreview(config, sources ?? {});
  return (
    <Card>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{t('launchesPendingTitle')}</strong>
          <Badge color="info">{t('launchesPendingPreview')}</Badge>
        </div>
        <p className="m-0 text-label text-ink-muted">{t('launchesPendingHelp')}</p>
        {config.method === 'catalog' && (
          <>
            {catalogName ? (
              <CopyResultField
                label={t('launchesCatalogName')}
                baseline={catalogName}
                value={catalogName}
                onCopyOutcome={outcome => {
                  onCopyOutcome?.('catalog_name', outcome);
                  if (outcome === 'success') onCopied?.('catalog_name', catalogName);
                }}
                compact
              />
            ) : (
              <div className="rounded-control border border-neutral-border p-3">
                <strong>{t('launchesCatalogName')}</strong>
                <p role="status" className="m-0 text-ink-muted">
                  {t('launchesPendingName')}
                </p>
              </div>
            )}
            <div className="rounded-control border border-neutral-border p-3">
              <strong>{t('launchesCatalogUrl')}</strong>
              <p className="m-0 text-ink-muted">{t('launchesPendingLink')}</p>
            </div>
          </>
        )}
        <div className="flex flex-col gap-2">
          {campaigns
            .filter(c => c.name)
            .map(c => (
              <CopyResultField
                key={c.ordinal}
                label={`${t('launchesCampaignName')} ${c.ordinal}`}
                baseline={c.name}
                value={c.name}
                onCopyOutcome={outcome => {
                  onCopyOutcome?.('campaign_name', outcome);
                  if (outcome === 'success') onCopied?.(`campaign:${c.ordinal}`, c.name);
                }}
                compact
                campaignOrdinal={String(c.ordinal).padStart(2, '0')}
                campaignBudget={`$${c.budget}`}
              />
            ))}
        </div>
        <div className="rounded-control border border-neutral-border p-3">
          <strong>{t('launchesAdvertisingUrl')}</strong>
          <p className="m-0 text-ink-muted">{t('launchesPendingLink')}</p>
        </div>
      </div>
    </Card>
  );
}
