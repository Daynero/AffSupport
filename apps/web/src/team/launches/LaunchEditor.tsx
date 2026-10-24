import { CircleHelp } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useEffect, useId, useRef, useState } from 'react';
import {
  launchBudgets,
  clampStitchEndDuration,
  launchNamingPreview,
  launchPreview,
  parseLaunchConfig,
  launchSubPreview,
  isLaunchUrl,
  missingLaunchSubSlots,
  type LaunchDraft,
  type LaunchSourceSnapshot,
  type TeamAccountSummary
} from '@video-compressor/shared';
import type { LaunchDictionaryItem } from '../../api/launches';
import {
  Button,
  Card,
  Accordion,
  FormField,
  Tooltip,
  Input,
  Switch,
  SegmentedControl,
  RestitchDurationControl
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { LaunchDictionaryManager } from './LaunchDictionaryManager';
import { LaunchAccountSelector } from './LaunchAccountSelector';
import { LaunchSelector } from './LaunchSelectors';
import { LaunchCreativePicker } from './LaunchCreativePicker';
import { SubBuilder } from './SubBuilder';
import { LaunchPreview } from './LaunchPreview';
import { LaunchDateField } from './LaunchDateField';
import { newLaunchCatalogConfig } from './launchCatalogDefaults';
export function LaunchEditor({
  teamId,
  config,
  sources,
  onChange,
  accounts,
  offers,
  buyers,
  onCreate,
  onDictionaryChanged,
  onDictionaryBusyChange,
  disabled,
  onRefreshSources,
  onUploadBusyChange,
  submitted = false
}: {
  teamId: string;
  config: LaunchDraft;
  sources: LaunchSourceSnapshot | null;
  onChange: (patch: LaunchDraft) => void;
  accounts: TeamAccountSummary[];
  offers: LaunchDictionaryItem[];
  buyers: LaunchDictionaryItem[];
  onCreate?: (kind: 'offers' | 'buyers', value: string) => Promise<string | void>;
  onDictionaryChanged?: (
    kind: 'offers' | 'buyers',
    removedId?: string,
    replacement?: string
  ) => Promise<void>;
  onDictionaryBusyChange?: (busy: boolean) => void;
  disabled: boolean;
  onRefreshSources: () => void;
  onUploadBusyChange?: (busy: boolean) => void;
  submitted?: boolean;
}) {
  const { t } = useI18n();
  const prefix = useId();
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [subSettingsOpen, setSubSettingsOpen] = useState(false);
  const [manualBudgetDraft, setManualBudgetDraft] = useState<number[]>(config.budgets ?? []);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (config.budgetMode === 'manual' && config.budgets) setManualBudgetDraft([...config.budgets]);
  }, [config.budgetMode, config.budgets]);
  useEffect(() => {
    if (!submitted) return;
    const firstError = [
      ...(editorRef.current?.querySelectorAll<HTMLElement>('.ui-field-error') ?? [])
    ].find(error => !error.closest('[hidden]'));
    const target = firstError?.closest('.ui-field');
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [submitted]);
  const changed = (patch: LaunchDraft) => {
    setTouched(previous => new Set([...previous, ...Object.keys(patch)]));
    onChange(patch);
  };
  const parsed = parseLaunchConfig(config);
  const preview = parsed.ok && sources ? launchPreview(parsed.value, sources) : null;
  const errors: Record<string, string> = {
    ...(preview && !preview.ok ? preview.errors : !parsed.ok ? parsed.errors : {})
  };
  const invalidSubSettings = Boolean(errors.sub1 || errors.sub2 || errors.sub3);
  useEffect(() => {
    if (submitted && invalidSubSettings) setSubSettingsOpen(true);
  }, [submitted, invalidSubSettings]);
  const account = accounts.find(account =>
    account.agents.some(agent => agent.id === config.agentRowId)
  );
  const agent = account?.agents.find(agent => agent.id === config.agentRowId);
  const localSources = {
    social: account?.name,
    agentId: agent?.agentId,
    offer: offers.find(offer => offer.id === config.offerId)?.value,
    buyer: buyers.find(buyer => buyer.id === config.buyerId)?.value
  };
  const subPreview = config.subConfig
    ? launchSubPreview(config.subConfig, config.creativeAlias, localSources)
    : null;
  if (config.method === 'catalog' && config.catalog) {
    const count = config.catalog.productCount;
    if (!Number.isSafeInteger(count) || count < 1 || count > 400)
      errors.productCount = 'INVALID_INPUT';
    const seconds = config.catalog.customFinalDurationSeconds;
    if (
      config.catalog.restitchEnabled &&
      (config.catalog.finalDurationMode === 'custom' ||
        config.catalog.finalDurationMode === 'random-centered') &&
      (seconds === null ||
        !Number.isSafeInteger(seconds) ||
        seconds <= 0 ||
        seconds % 60 !== 0 ||
        clampStitchEndDuration(seconds) !== seconds)
    )
      errors.customFinalDurationSeconds = 'INVALID_INPUT';
  }
  const helpHint = (text: string) => (
    <Tooltip label={text} asChild>
      <span tabIndex={0} aria-label={text} className="inline-flex text-ink-muted">
        <CircleHelp size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </span>
    </Tooltip>
  );
  const field = (
    key: string,
    label: TranslationKey,
    children: React.ReactNode,
    validate = true,
    help?: TranslationKey
  ) => {
    const showError =
      validate &&
      Boolean(errors[key]) &&
      (submitted ||
        touched.has(key) ||
        ((key === 'productCount' || key === 'customFinalDurationSeconds') &&
          touched.has('catalog')));
    return (
      <FormField
        label={t(label)}
        htmlFor={`${prefix}-${key}`}
        hint={help ? helpHint(t(help)) : undefined}
        required={false}
        error={
          showError
            ? t(
                key === 'budgets' || errors[key] === 'LAUNCH_BUDGET_INVALID'
                  ? 'launchesBudgetInvalid'
                  : key === 'creativeAlias'
                    ? 'launchesCreativeNameInvalid'
                    : key === 'originalUrl'
                      ? 'launchesUrlInvalid'
                      : submitted
                        ? key === 'campaignCount'
                          ? 'launchesCampaignCountInvalid'
                          : key === 'maxBudget' || key === 'minBudget'
                            ? 'launchesMaxBudgetInvalid'
                            : key === 'adsCount'
                              ? 'launchesAdsCountInvalid'
                              : key === 'age'
                                ? 'launchesAgeInvalid'
                                : key === 'launchDate'
                                  ? 'launchesDateInvalid'
                                  : key === 'productCount'
                                    ? 'launchesProductCountInvalid'
                                    : key === 'customFinalDurationSeconds'
                                      ? 'launchesDurationInvalid'
                                      : 'launchesInvalid'
                        : 'launchesRequired'
              )
            : undefined
        }
      >
        {children}
      </FormField>
    );
  };
  const number = (
    key: 'campaignCount' | 'minBudget' | 'maxBudget' | 'adsCount' | 'age',
    label: TranslationKey,
    suffix?: string,
    help?: TranslationKey,
    trailing?: React.ReactNode
  ) => {
    const input = (
      <Input
        id={`${prefix}-${key}`}
        type="number"
        inputMode="numeric"
        min={1}
        max={
          key === 'campaignCount'
            ? 100
            : key === 'maxBudget' || key === 'minBudget'
              ? 999999
              : key === 'adsCount'
                ? 1000
                : undefined
        }
        step={1}
        width="narrow"
        suffix={suffix}
        disabled={disabled}
        value={
          key === 'minBudget'
            ? config.minBudget === undefined
              ? (budgets[0] ?? '')
              : config.minBudget === 0
                ? ''
                : config.minBudget
            : (config[key] ?? '')
        }
        onChange={e => {
          const next =
            e.target.value === '' ? (key === 'minBudget' ? 0 : undefined) : Number(e.target.value);
          if (
            key === 'campaignCount' &&
            config.budgetMode === 'manual' &&
            Number.isInteger(next) &&
            next! >= 1 &&
            next! <= 100
          ) {
            const resized = Array.from(
              { length: next! },
              (_, index) => config.budgets?.[index] ?? 0
            );
            setManualBudgetDraft(resized);
            changed({
              campaignCount: next,
              budgets: resized,
              ...(next! < (config.campaignCount ?? 0) && resized.some(value => value > 0)
                ? { maxBudget: Math.max(...resized) }
                : {})
            });
          } else
            changed({
              [key]: next,
              ...((key === 'maxBudget' || key === 'campaignCount') &&
              config.budgetMode !== 'manual' &&
              config.minBudget === undefined &&
              budgets.length
                ? { minBudget: budgets[0] }
                : {})
            });
        }}
      />
    );
    return field(
      key,
      label,
      trailing ? (
        <div className="launch-editor-auto-budget">
          {input}
          {trailing}
        </div>
      ) : (
        input
      ),
      true,
      help
    );
  };
  let budgets: number[] = config.budgetMode === 'manual' ? [...(config.budgets ?? [])] : [];
  try {
    budgets = launchBudgets(
      config.campaignCount ?? 0,
      config.maxBudget ?? 0,
      config.budgetMode === 'manual' ? config.budgets : null,
      config.minBudget
    );
  } catch {
    errors.budgets = 'LAUNCH_BUDGET_INVALID';
    if (config.budgetMode !== 'manual') {
      errors.minBudget = 'LAUNCH_BUDGET_INVALID';
      errors.maxBudget = 'LAUNCH_BUDGET_INVALID';
    }
  }
  const previewRows = launchNamingPreview(config, localSources);
  const missingSubSlots = isLaunchUrl(config.originalUrl)
    ? missingLaunchSubSlots(config.originalUrl)
    : [];
  const subOpenIds =
    subSettingsOpen || (submitted && invalidSubSettings)
      ? new Set(['launch-sub-settings'])
      : new Set<string>();
  return (
    <div ref={editorRef} className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-3">
      <Card role="panel">
        <fieldset disabled={disabled} className="m-0 flex flex-col gap-4 border-0 p-0">
          <section className="launch-editor-section" aria-labelledby={`${prefix}-sources-heading`}>
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-sources-heading`} className="flex items-center gap-2">
                  {t('launchesSectionSources')}
                </h3>
              </div>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={onRefreshSources}>
                {t('launchesRefreshSources')}
              </Button>
            </div>
            <div className="launch-editor-source-grid">
              <div className="min-w-0">
                {field(
                  'agentRowId',
                  'launchesAccount',
                  <LaunchAccountSelector
                    id={`${prefix}-agentRowId`}
                    value={config.agentRowId ?? ''}
                    disabled={disabled}
                    accounts={accounts}
                    onChange={agentRowId => changed({ agentRowId })}
                  />
                )}
              </div>
              <div className="min-w-0">
                {field(
                  'offerId',
                  'launchesOffer',
                  <div className="launch-editor-dictionary-row">
                    <LaunchSelector
                      id={`${prefix}-offerId`}
                      label={t('launchesOffer')}
                      disabled={disabled}
                      value={config.offerId ?? ''}
                      options={offers.map(x => ({ value: x.id, label: x.value }))}
                      onChange={offerId => changed({ offerId })}
                      onCreate={onCreate ? v => onCreate('offers', v) : undefined}
                    />
                    {onDictionaryChanged && (
                      <LaunchDictionaryManager
                        teamId={teamId}
                        kind="offers"
                        items={offers}
                        selected={config.offerId ?? ''}
                        disabled={disabled}
                        onBusyChange={onDictionaryBusyChange}
                        onChanged={(removedId, replacement) =>
                          onDictionaryChanged('offers', removedId, replacement)
                        }
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                {field(
                  'buyerId',
                  'launchesBuyer',
                  <div className="launch-editor-dictionary-row">
                    <LaunchSelector
                      id={`${prefix}-buyerId`}
                      label={t('launchesBuyer')}
                      disabled={disabled}
                      value={config.buyerId ?? ''}
                      options={buyers.map(x => ({ value: x.id, label: x.value }))}
                      onChange={buyerId => changed({ buyerId })}
                      onCreate={onCreate ? v => onCreate('buyers', v) : undefined}
                    />
                    {onDictionaryChanged && (
                      <LaunchDictionaryManager
                        teamId={teamId}
                        kind="buyers"
                        items={buyers}
                        selected={config.buyerId ?? ''}
                        disabled={disabled}
                        onBusyChange={onDictionaryBusyChange}
                        onChanged={(removedId, replacement) =>
                          onDictionaryChanged('buyers', removedId, replacement)
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="launch-editor-creative">
              <LaunchCreativePicker
                teamId={teamId}
                sources={sources}
                config={config}
                onChange={changed}
                onBusyChange={onUploadBusyChange}
                submitted={submitted}
                disabled={disabled}
              />
            </div>
          </section>

          <section
            className="launch-editor-section"
            aria-labelledby={`${prefix}-campaigns-heading`}
          >
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-campaigns-heading`}>{t('launchesSectionCampaigns')}</h3>
              </div>
            </div>
            <div className="launch-editor-fields-row">
              {number('campaignCount', 'launchesCampaignCount')}
              {number('adsCount', 'launchesAdsCount')}
            </div>
            <div className="launch-editor-budget">
              <span className="ui-field-label">
                {t(config.campaignCount === 1 ? 'launchesBudgetSingle' : 'launchesBudgetMultiple')}
              </span>
              <div className="launch-editor-budget-row">
                <SegmentedControl
                  label={t('launchesBudgetMode')}
                  size="sm"
                  value={config.budgetMode ?? 'auto'}
                  disabled={disabled}
                  options={[
                    { value: 'auto', label: t('launchesAutomatic') },
                    { value: 'manual', label: t('launchesCustomBudgets') }
                  ]}
                  onChange={mode => {
                    if (mode === 'auto' || mode === 'manual')
                      if (mode === 'auto') changed({ budgetMode: 'auto', budgets: null });
                      else {
                        const manual =
                          manualBudgetDraft.length === (config.campaignCount ?? 0)
                            ? manualBudgetDraft
                            : budgets;
                        setManualBudgetDraft(manual);
                        changed({
                          budgetMode: 'manual',
                          budgets: manual,
                          ...(manual.length ? { maxBudget: Math.max(...manual) } : {})
                        });
                      }
                  }}
                />
                {config.budgetMode !== 'manual' ? (
                  <>
                    {number('minBudget', 'launchesMinBudget')}
                    {number(
                      'maxBudget',
                      'launchesBudgetMaximum',
                      undefined,
                      undefined,
                      budgets.length > 0 ? (
                        <output
                          className="launch-editor-budget-preview"
                          aria-label={t('launchesBudget')}
                        >
                          {budgets.map((budget, index) => (
                            <span key={index}>
                              {budget} <span className="launch-editor-budget-currency">$</span>
                            </span>
                          ))}
                        </output>
                      ) : undefined
                    )}
                  </>
                ) : (
                  field(
                    'budgets',
                    'launchesBudget',
                    <div className="launch-editor-budget-values">
                      {budgets.map((v, i) => (
                        <Input
                          key={i}
                          type="number"
                          width="narrow"
                          suffix="$"
                          value={v === 0 ? '' : v}
                          disabled={disabled}
                          aria-label={`${t('launchesBudget')} ${i + 1}`}
                          onChange={e => {
                            const manual = [...budgets];
                            manual[i] = Number(e.target.value);
                            setManualBudgetDraft(manual);
                            changed({
                              budgetMode: 'manual',
                              budgets: manual,
                              maxBudget: Math.max(...manual)
                            });
                          }}
                        />
                      ))}
                    </div>
                  )
                )}
              </div>
            </div>
          </section>

          <section className="launch-editor-section" aria-labelledby={`${prefix}-method-heading`}>
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-method-heading`}>{t('launchesSectionMethod')}</h3>
              </div>
            </div>
            <SegmentedControl
              label={t('launchesMethod')}
              disabled={disabled}
              value={config.method ?? 'other'}
              options={[
                { value: 'catalog', label: t('launchesCatalog') },
                { value: 'other', label: t('launchesOther') }
              ]}
              onChange={method => {
                if (method === 'catalog' || method === 'other')
                  changed({
                    method,
                    ...(method === 'catalog' && !config.catalog
                      ? { catalog: newLaunchCatalogConfig() }
                      : {})
                  });
              }}
            />
            {config.method === 'catalog' && config.catalog && (
              <div className="launch-editor-catalog-options">
                {field(
                  'productCount',
                  'launchesCatalogProductCount',
                  <Input
                    id={`${prefix}-productCount`}
                    aria-label={t('launchesCatalogProductCount')}
                    type="number"
                    width="narrow"
                    value={config.catalog.productCount}
                    min={1}
                    max={400}
                    disabled={disabled}
                    onChange={e =>
                      changed({
                        catalog: { ...config.catalog!, productCount: Number(e.target.value) }
                      })
                    }
                  />,
                  true,
                  'launchesCatalogProductCountHelp'
                )}
                <div className="launch-editor-restitch">
                  <Switch
                    label={t('launchesRestitch')}
                    checked={config.catalog.restitchEnabled}
                    disabled={disabled}
                    onChange={restitchEnabled =>
                      changed({ catalog: { ...config.catalog!, restitchEnabled } })
                    }
                  />
                  {config.catalog.restitchEnabled && (
                    <RestitchDurationControl
                      value={config.catalog}
                      disabled={disabled}
                      labels={{
                        duration: t('launchesDuration'),
                        range: t('launchesDurationRange'),
                        exact: t('launchesDurationExact'),
                        unit: t('launchesMinutesShort')
                      }}
                      onChange={duration =>
                        changed({ catalog: { ...config.catalog!, ...duration } })
                      }
                    />
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="launch-editor-section" aria-labelledby={`${prefix}-audience-heading`}>
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-audience-heading`}>{t('launchesSectionAudience')}</h3>
              </div>
            </div>
            <div className="launch-editor-fields-row launch-editor-audience-row">
              <SegmentedControl
                label={t('launchesGender')}
                disabled={disabled}
                value={config.gender ?? 'M'}
                options={[
                  { value: 'M', label: t('launchesGenderMale') },
                  { value: 'W', label: t('launchesGenderFemale') },
                  { value: 'ALL', label: t('launchesGenderAll') }
                ]}
                onChange={v => {
                  if (v === 'M' || v === 'W' || v === 'ALL') changed({ gender: v });
                }}
              />
              <Switch
                label={t('launchesAdvantage')}
                disabled={disabled}
                checked={config.advantagePlus ?? false}
                onChange={advantagePlus => changed({ advantagePlus })}
              />
              {number('age', 'launchesAge', '+')}
              <LaunchDateField
                value={config.launchDate}
                timezone={config.timezone}
                disabled={disabled}
                error={
                  errors.launchDate && (submitted || touched.has('launchDate'))
                    ? t('launchesDateInvalid')
                    : undefined
                }
                onChange={launchDate => changed({ launchDate })}
              />
            </div>
          </section>

          <section className="launch-editor-section" aria-labelledby={`${prefix}-links-heading`}>
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-links-heading`}>{t('launchesSectionLinks')}</h3>
              </div>
            </div>
            {field(
              'originalUrl',
              'launchesUrl',
              <Input
                id={`${prefix}-originalUrl`}
                aria-label={t('launchesUrl')}
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={config.originalUrl ?? ''}
                disabled={disabled}
                onPaste={e => {
                  if (disabled) return;
                  const raw = e.clipboardData.getData('text/plain');
                  if (!raw) return;
                  e.preventDefault();
                  const original = config.originalUrl ?? '';
                  const start = e.currentTarget.selectionStart ?? original.length;
                  const end = e.currentTarget.selectionEnd ?? start;
                  changed({ originalUrl: original.slice(0, start) + raw + original.slice(end) });
                }}
                onChange={e => changed({ originalUrl: e.target.value })}
              />,
              true,
              'launchesUrlHelp'
            )}
            <p
              className="launch-editor-url-warning"
              role="status"
              aria-live="polite"
              data-reserve={t('launchesSubNotFound', { slots: 'SUB1, SUB2, SUB3' })}
            >
              <span>
                {missingSubSlots.length > 0
                  ? t('launchesSubNotFound', {
                      slots: missingSubSlots.map(slot => slot.toUpperCase()).join(', ')
                    })
                  : null}
              </span>
            </p>
            {config.subConfig && (
              <Accordion
                className="launch-editor-sub-accordion"
                items={[
                  {
                    id: 'launch-sub-settings',
                    title: t('launchesSubSettings'),
                    aside: t('launchesAdditional'),
                    content: (
                      <div className="launch-editor-sub-content">
                        <p>{t('launchesSubSettingsHelp')}</p>
                        <div className="grid min-w-0 gap-6 lg:grid-cols-3">
                          {(['sub1', 'sub2', 'sub3'] as const).map(slot => (
                            <SubBuilder
                              key={slot}
                              slot={slot}
                              selected={config.subConfig![slot]}
                              disabled={disabled}
                              onChange={selected =>
                                changed({ subConfig: { ...config.subConfig!, [slot]: selected } })
                              }
                              preview={subPreview?.[slot] ?? null}
                              submitted={submitted}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  }
                ]}
                openIds={subOpenIds}
                onToggle={id =>
                  setSubSettingsOpen(open => (id === 'launch-sub-settings' ? !open : open))
                }
              />
            )}
          </section>
        </fieldset>
      </Card>
      <LaunchPreview value={null} rows={previewRows} />
    </div>
  );
}
