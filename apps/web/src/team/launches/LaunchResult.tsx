import { LaunchCopyHistory } from './LaunchCopyHistory';
import { useOptionalAuth } from '../../auth/AuthContext';
import { LaunchNotesResult } from './LaunchNotes';
import type { LaunchNote } from '@video-compressor/shared';
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
  notes = revision.config.notes ?? [],
  overrides,
  onChange,
  onSave,
  onRegenerate,
  editable,
  disabled,
  settingsChanged = false,
  launchId,
  teamId
}: {
  revision: LaunchRevision;
  notes?: LaunchNote[];
  overrides: LaunchOverrides;
  onChange: (overrides: LaunchOverrides) => void;
  onSave: () => void;
  onRegenerate?: () => void;
  editable: boolean;
  disabled: boolean;
  settingsChanged?: boolean;
  launchId?: string;
  teamId?: string;
}) {
  const { t, language } = useI18n();
  const auth = useOptionalAuth();
  const actorId = auth?.user?.id;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const copyScope =
    actorId &&
    teamId &&
    launchId &&
    [actorId, teamId, launchId, revision.id].every(id => uuid.test(id))
      ? { actorId, teamId, launchId, revisionId: revision.id }
      : null;
  const copyValues: Record<string, string> = {
    advertising_url: overrides.advertisingUrl ?? revision.baseline.advertisingUrl,
    ...Object.fromEntries(
      revision.baseline.campaigns.map(c => [
        `campaign:${c.ordinal}`,
        overrides.campaigns?.[String(c.ordinal)]?.name ?? c.name
      ])
    ),
    ...Object.fromEntries(
      notes.filter(note => note.text.trim()).map(note => [`note:${note.id}`, note.text])
    ),
    ...(revision.catalog
      ? {
          catalog_name: overrides.catalogName ?? revision.catalog.name,
          ...(revision.catalog.available === false
            ? {}
            : { catalog_url: overrides.catalogUrl ?? revision.catalog.url })
        }
      : {})
  };

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
    <LaunchCopyHistory
      scope={copyScope}
      lineageId={revision.baselineRevisionId ?? revision.id}
      values={copyValues}
    >
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
            <span className="launch-result-hint">
              <Info size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('launchesCopyHint')}
            </span>
            {revision.catalog && (
              <section className="launch-result-copy-section" aria-label={t('launchesCatalog')}>
                <CopyResultField
                  compact
                  copyKey="catalog_name"
                  onCopyOutcome={copied('catalog_name')}
                  label={t('launchesCatalogName')}
                  baseline={revision.catalog.name}
                  value={overrides.catalogName ?? revision.catalog.name}
                  editable={editable}
                  disabled={disabled}
                  onChange={value => update('catalogName', value, revision.catalog!.name)}
                />
                {revision.catalog.available === false && (
                  <span className="launch-result-hint">{t('launchesCatalogDeleted')}</span>
                )}
                {revision.catalog.available !== false && (
                  <CopyResultField
                    compact
                    openExternal
                    copyKey="catalog_url"
                    onCopyOutcome={copied('catalog_url')}
                    label={t('launchesCatalogUrl')}
                    validate={isLaunchUrl}
                    baseline={revision.catalog.url}
                    value={overrides.catalogUrl ?? revision.catalog.url}
                    editable={editable}
                    disabled={disabled}
                    onChange={value => update('catalogUrl', value, revision.catalog!.url)}
                  />
                )}
              </section>
            )}
            <section className="launch-result-campaigns" aria-label={t('launchesCampaignNames')}>
              <div className="launch-result-section-heading">
                <h3>{t('launchesCampaignNames')}</h3>
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
                      copyKey={`campaign:${c.ordinal}`}
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
            <section
              className="launch-result-copy-section"
              aria-label={t('launchesAdvertisingUrl')}
            >
              <CopyResultField
                compact
                openExternal
                copyKey="advertising_url"
                onCopyOutcome={copied('advertising_url')}
                label={t('launchesUrl')}
                displayLabel={t('launchesAdvertisingUrl')}
                validate={isLaunchUrl}
                baseline={revision.baseline.advertisingUrl}
                value={overrides.advertisingUrl ?? revision.baseline.advertisingUrl}
                editable={editable}
                disabled={disabled}
                onChange={value =>
                  update('advertisingUrl', value, revision.baseline.advertisingUrl)
                }
              />
            </section>
            <LaunchNotesResult notes={notes} disabled={disabled} />
          </div>
        </Card>
      </div>
    </LaunchCopyHistory>
  );
}
