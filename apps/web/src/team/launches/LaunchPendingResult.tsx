import {
  launchNamingPreview,
  type LaunchDraft,
  type LaunchGenerationState,
  type LaunchSourceSnapshot
} from '@video-compressor/shared';
import { Badge, Button, Card } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { CopyResultField } from './CopyResultField.js';

/** The states in which the server is still working towards a result. */
const RESULT_IN_FLIGHT: readonly LaunchGenerationState[] = [
  'accepted',
  'running',
  'waiting_dependency'
];

/**
 * Whether «Preparing your result» is true. Only a run that is still going can bring a
 * result: a canceled, failed or cancelling one has nothing on its way, and its reserved
 * catalog name and coming links were a promise the page could not keep (070, 9и — a
 * canceled launch read «Preparing your result · Reserving catalog name…» for good).
 * A request of this page's own still in the air counts, unless it is the cancel.
 */
export function launchResultPending({
  busy,
  unresolved,
  stage,
  state
}: {
  busy: boolean;
  unresolved: boolean;
  stage: string | null;
  state: LaunchGenerationState | null | undefined;
}): boolean {
  if (stage === 'cancel') return false;
  if (busy || unresolved) return true;
  return state != null && RESULT_IN_FLIGHT.includes(state);
}

/**
 * Canceled: no result is coming. A cancel still being carried out counts only where no
 * progress card already says «cancelling» — otherwise the tab would announce the end early.
 */
export function launchResultStopped(
  state: LaunchGenerationState | null | undefined,
  progressShown: boolean
): boolean {
  if (state === 'canceled' || state === 'canceled_with_cleanup_pending') return true;
  return state === 'cancel_requested' && !progressShown;
}

/**
 * The Result tab of a launch that was canceled before it made anything: what happened and
 * the way on, instead of a preview of links that will never come.
 */
export function LaunchStoppedResult({ onSettings }: { onSettings: () => void }) {
  const { t } = useI18n();
  return (
    <Card>
      <div className="flex min-w-0 flex-col items-start gap-3">
        <strong>{t('launchesStoppedTitle')}</strong>
        <p className="m-0 text-label text-ink-muted">{t('launchesStoppedHelp')}</p>
        <Button color="neutral" onClick={onSettings}>
          {t('launchesStoppedSettings')}
        </Button>
      </div>
    </Card>
  );
}

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
              <div className="rounded-md border border-neutral-border p-3">
                <strong>{t('launchesCatalogName')}</strong>
                <p role="status" className="m-0 text-ink-muted">
                  {t('launchesPendingName')}
                </p>
              </div>
            )}
            <div className="rounded-md border border-neutral-border p-3">
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
        <div className="rounded-md border border-neutral-border p-3">
          <strong>{t('launchesAdvertisingUrl')}</strong>
          <p className="m-0 text-ink-muted">{t('launchesPendingLink')}</p>
        </div>
      </div>
    </Card>
  );
}
