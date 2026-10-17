import { useEffect, useRef } from 'react';
import {
  isLaunchUrl,
  parseLaunchOverrides,
  launchValuesEqual,
  type LaunchRevision,
  type LaunchOverrides,
  type LaunchAnalyticsField
} from '@video-compressor/shared';
import { ArrowRight, CalendarDays, Info } from 'lucide-react';
import { Button, Card } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { CopyResultField } from './CopyResultField';
import { launchAction } from './analytics';
import { campaignCountLabel } from './campaignCountLabel';

export function LaunchResult({
  revision,
  overrides,
  onChange,
  onSave,
  onRegenerate,
  editable,
  disabled,
  settingsChanged = false,
  launchId
}: {
  revision: LaunchRevision;
  overrides: LaunchOverrides;
  onChange: (overrides: LaunchOverrides) => void;
  onSave: () => void;
  onRegenerate?: () => void;
  editable: boolean;
  disabled: boolean;
  settingsChanged?: boolean;
  launchId?: string;
}) {
  const { t, language } = useI18n();
  const userEdited = useRef(false);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const overridesDirty = !launchValuesEqual(overrides, revision.overrides);
  useEffect(() => {
    if (!overridesDirty) {
      userEdited.current = false;
      return;
    }
    if (!editable || disabled || !userEdited.current) return;
    const timer = window.setTimeout(() => saveRef.current(), 700);
    return () => window.clearTimeout(timer);
  }, [overridesDirty, overrides, editable, disabled]);
  const [year, month, day] = revision.config.launchDate.split('-').map(Number);
  const launchDate = new Date(year, month - 1, day);
  const dateLabel = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(launchDate);
  const copied = (field: LaunchAnalyticsField) => (outcome: 'success' | 'failure') =>
    launchAction({ launchId, revisionId: revision.id }, 'copy_field', outcome, undefined, field);
  const update = (
    key: 'advertisingUrl' | 'catalogName' | 'catalogUrl',
    value: string,
    baseline: string
  ) => {
    const next = { ...overrides };
    if (value === baseline) delete next[key];
    else next[key] = value;
    userEdited.current = true;
    onChange(next);
  };
  const campaign = (ordinal: number, key: 'name', value: string, baseline: string) => {
    const next: LaunchOverrides = { ...overrides, campaigns: { ...overrides.campaigns } };
    const rows = next.campaigns!;
    const row = { ...rows[String(ordinal)] };
    if (value === baseline) delete row[key];
    else row[key] = value;
    if (Object.keys(row).length) rows[String(ordinal)] = row;
    else delete rows[String(ordinal)];
    if (!Object.keys(rows).length) delete next.campaigns;
    userEdited.current = true;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {settingsChanged && (
        <div role="status" className="launch-result-warning">
          <Info size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>{t('launchesResultSettingsChanged')}</span>
          <Button
            variant="ghost"
            color="warning"
            disabled={disabled || !editable || !onRegenerate}
            className="launch-result-regenerate"
            onClick={() => onRegenerate?.()}
          >
            {t('launchesGenerateUpdate')}
            <ArrowRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </Button>
        </div>
      )}
      <Card
        role="section"
        className="launch-result-card"
        title={`${revision.sources.offer} / ${revision.sources.social}-${revision.sources.agentId.slice(-3)} / ${revision.config.creativeAlias}`}
        aside={
          <span className="launch-result-date">
            <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {dateLabel}
          </span>
        }
        description={`${revision.config.gender}${revision.config.age}+ · ${revision.config.method === 'catalog' ? t('launchesCatalog') : t('launchesOther')} · ${revision.config.campaignCount} ${campaignCountLabel(language, revision.config.campaignCount)}`}
      >
        <div className="launch-result-content">
          <section className="launch-result-campaigns" aria-label={t('launchesCampaignNames')}>
            <div className="launch-result-section-heading">
              <h3>{t('launchesCampaignNames')}</h3>
              <span className="launch-result-hint">
                <Info size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('launchesCopyHint')}
              </span>
            </div>
            <div
              className="launch-result-campaign-list"
              role="group"
              aria-label={t('launchesCampaignNames')}
            >
              {revision.baseline.campaigns.map(c => {
                const row = overrides.campaigns?.[String(c.ordinal)];
                return (
                  <CopyResultField
                    key={c.ordinal}
                    compact
                    campaignOrdinal={String(c.ordinal).padStart(2, '0')}
                    campaignBudget={`$${row?.budget ?? c.budget}`}
                    onCopyOutcome={copied('campaign_name')}
                    label={`${t('launchesCampaignName')} #${c.ordinal}`}
                    displayLabel={String(c.ordinal).padStart(2, '0')}
                    baseline={c.name}
                    validate={v =>
                      parseLaunchOverrides(
                        { campaigns: { [String(c.ordinal)]: { name: v } } },
                        revision.config.campaignCount
                      ).ok
                    }
                    value={row?.name ?? c.name}
                    editable={editable}
                    disabled={disabled}
                    onChange={v => campaign(c.ordinal, 'name', v, c.name)}
                  />
                );
              })}
            </div>
          </section>
          {revision.catalog && (
            <section className="launch-result-copy-section" aria-label={t('launchesCatalog')}>
              <CopyResultField
                compact
                onCopyOutcome={copied('catalog_name')}
                label={t('launchesCatalogName')}
                baseline={revision.catalog.name}
                value={overrides.catalogName ?? revision.catalog.name}
                editable={editable}
                disabled={disabled}
                onChange={value => update('catalogName', value, revision.catalog!.name)}
              />
              <CopyResultField
                compact
                openExternal
                onCopyOutcome={copied('catalog_url')}
                label={t('launchesCatalogUrl')}
                validate={isLaunchUrl}
                baseline={revision.catalog.url}
                value={overrides.catalogUrl ?? revision.catalog.url}
                editable={editable}
                disabled={disabled}
                onChange={value => update('catalogUrl', value, revision.catalog!.url)}
              />
            </section>
          )}
          <section className="launch-result-copy-section" aria-label={t('launchesAdvertisingUrl')}>
            <CopyResultField
              compact
              openExternal
              onCopyOutcome={copied('advertising_url')}
              label={t('launchesUrl')}
              displayLabel={t('launchesAdvertisingUrl')}
              validate={isLaunchUrl}
              baseline={revision.baseline.advertisingUrl}
              value={overrides.advertisingUrl ?? revision.baseline.advertisingUrl}
              editable={editable}
              disabled={disabled}
              onChange={value => update('advertisingUrl', value, revision.baseline.advertisingUrl)}
            />
          </section>
        </div>
      </Card>
    </div>
  );
}
