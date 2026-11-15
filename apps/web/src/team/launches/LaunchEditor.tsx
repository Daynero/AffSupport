import { LaunchNotesEditor } from './LaunchNotes';
import { CircleHelp, RefreshCw } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  Card,
  Accordion,
  FormField,
  IconButton,
  Tooltip,
  Input,
  Textarea,
  Switch,
  SegmentedControl
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { LaunchDictionaryManager } from './LaunchDictionaryManager';
import { LaunchAccountSelector } from './LaunchAccountSelector';
import { LaunchSelector } from './LaunchSelectors';
import { LaunchCreativePicker } from './LaunchCreativePicker';
import { LaunchRestitchDurationField } from './LaunchRestitchDurationField.js';
import { SubBuilder } from './SubBuilder';
import { LaunchPreview } from './LaunchPreview';
import { LaunchDateField } from './LaunchDateField';
import { newLaunchCatalogConfig } from './launchCatalogDefaults';
import { CatalogVideoR2Toggle } from '../product-catalog/CatalogVideoR2Toggle';

const LaunchCatalogVideoFields = lazy(() =>
  import('./LaunchCatalogVideoFields').then(module => ({
    default: module.LaunchCatalogVideoFields
  }))
);
export function LaunchEditor({
  teamId,
  config,
  sources,
  onChange,
  accounts,
  accountAssignment,
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
  accountAssignment?: ReactNode;
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
  const [catalogAdvancedOpen, setCatalogAdvancedOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
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
  const scheduledPublication = config.catalog?.videoPublication?.mode === 'scheduled';
  const invalidCatalog = Boolean(errors.catalog);
  useEffect(() => {
    if (scheduledPublication || (submitted && invalidCatalog)) setCatalogAdvancedOpen(true);
  }, [scheduledPublication, submitted, invalidCatalog]);
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
  const subValues = Object.entries(subPreview ?? {}).filter(([, value]) => value !== null);
  const subSummary = subValues
    .map(([slot, value]) => `${slot.toUpperCase()} — ${value}`)
    .join(' · ');
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
  const shortLabels: Record<string, TranslationKey> = {
    campaignCount: 'launchSettingsCampaignCount',
    adsCount: 'launchSettingsAdsCount',
    minBudget: 'launchSettingsBudgetFrom',
    maxBudget:
      config.budgetMode === 'single' ? 'launchesBudgetPerCampaign' : 'launchSettingsBudgetTo',
    age: 'launchSettingsAge',
    productCount: 'launchSettingsProducts'
  };
  const budgetKeys = ['minBudget', 'maxBudget', 'budgets'];
  const budgetError =
    !editingBudget &&
    budgetKeys.some(key => Boolean(errors[key])) &&
    (submitted || budgetKeys.some(key => touched.has(key)));
  const field = (
    key: string,
    label: TranslationKey,
    children: React.ReactNode,
    validate = true,
    help?: TranslationKey
  ) => {
    const showError =
      validate &&
      !budgetKeys.includes(key) &&
      Boolean(errors[key]) &&
      (submitted || touched.has(key) || (key === 'productCount' && touched.has('catalog')));
    return (
      <FormField
        label={t(shortLabels[key] ?? label)}
        htmlFor={`${prefix}-${key}`}
        hint={help ? helpHint(t(help)) : undefined}
        required={false}
        error={
          showError
            ? t(
                key === 'originalUrl'
                  ? 'launchesUrlInvalid'
                  : submitted
                    ? key === 'campaignCount'
                      ? 'launchesCampaignCountInvalid'
                      : key === 'adsCount'
                        ? 'launchesAdsCountInvalid'
                        : key === 'age'
                          ? 'launchesAgeInvalid'
                          : key === 'productCount'
                            ? 'launchesProductCountInvalid'
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
  const dictionary = (
    key: 'offerId' | 'buyerId',
    label: TranslationKey,
    kind: 'offers' | 'buyers',
    items: LaunchDictionaryItem[]
  ) => (
    <div className="min-w-0">
      {field(
        key,
        label,
        <div className="launch-editor-dictionary-row">
          <LaunchSelector
            id={`${prefix}-${key}`}
            label={t(label)}
            disabled={disabled}
            value={config[key] ?? ''}
            options={items.map(item => ({ value: item.id, label: item.value }))}
            onChange={value => changed({ [key]: value })}
            onCreate={onCreate ? value => onCreate(kind, value) : undefined}
          />
          {onDictionaryChanged && (
            <LaunchDictionaryManager
              teamId={teamId}
              kind={kind}
              items={items}
              selected={config[key] ?? ''}
              disabled={disabled}
              onBusyChange={onDictionaryBusyChange}
              onChanged={(removedId, replacement) =>
                onDictionaryChanged(kind, removedId, replacement)
              }
            />
          )}
        </div>
      )}
    </div>
  );
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
        aria-label={t(label)}
        type="number"
        inputMode="numeric"
        invalid={budgetKeys.includes(key) && budgetError}
        aria-describedby={
          budgetKeys.includes(key) && budgetError ? `${prefix}-budget-error` : undefined
        }
        onFocus={budgetKeys.includes(key) ? () => setEditingBudget(true) : undefined}
        onBlur={budgetKeys.includes(key) ? () => setEditingBudget(false) : undefined}
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
              (config.budgetMode ?? 'auto') === 'auto' &&
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
      key === 'maxBudget' ? (
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
      config.minBudget,
      config.budgetMode
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
    <div
      ref={editorRef}
      className="launch-editor-compact mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-3"
    >
      <Card role="panel">
        <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <section className="launch-editor-section" aria-label={t('launchesSectionSources')}>
            <div className="launch-editor-source-grid">
              <div className="flex min-w-0 flex-col gap-3">
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
                {accountAssignment}
              </div>
              {dictionary('offerId', 'launchesOffer', 'offers', offers)}
              {dictionary('buyerId', 'launchesBuyer', 'buyers', buyers)}
              <IconButton
                className="launch-editor-refresh"
                label={t('launchesRefreshSources')}
                variant="ghost"
                disabled={disabled}
                onClick={onRefreshSources}
              >
                <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
            </div>
            <div className="launch-editor-input-grid">
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
              <div className="launch-editor-link-field">
                {field(
                  'originalUrl',
                  'launchesSectionLinks',
                  // A long tracking link wraps instead of hiding past the edge: a
                  // one-line input cannot be scrolled sideways with a trackpad.
                  <Textarea
                    id={`${prefix}-originalUrl`}
                    className="launch-editor-url"
                    aria-label={t('launchesUrl')}
                    rows={1}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={config.originalUrl ?? ''}
                    disabled={disabled}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    onPaste={e => {
                      if (disabled) return;
                      const raw = e.clipboardData.getData('text/plain').replace(/[\r\n]+/g, '');
                      if (!raw) return;
                      e.preventDefault();
                      const original = config.originalUrl ?? '';
                      const start = e.currentTarget.selectionStart ?? original.length;
                      const end = e.currentTarget.selectionEnd ?? start;
                      changed({
                        originalUrl: original.slice(0, start) + raw + original.slice(end)
                      });
                    }}
                    onChange={e => changed({ originalUrl: e.target.value.replace(/[\r\n]+/g, '') })}
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
              </div>
            </div>
            {config.subConfig && (
              <Accordion
                className="launch-editor-sub-accordion"
                items={[
                  {
                    id: 'launch-sub-settings',
                    title: t('launchesSubSettings'),
                    aside: subSummary ? (
                      <span title={subSummary}>
                        {subValues.map(([slot, value], index) => (
                          <span key={slot}>
                            {index > 0 && ' · '}
                            {slot.toUpperCase()} — <strong>{value}</strong>
                          </span>
                        ))}
                      </span>
                    ) : undefined,
                    content: (
                      <div className="launch-editor-sub-content">
                        <p>{t('launchesSubSettingsHelp')}</p>
                        <div className="grid min-w-0 gap-6 lg:grid-cols-3">
                          {(['sub1', 'sub2', 'sub3'] as const).map(slot => (
                            <SubBuilder
                              catalogEnabled={config.method === 'catalog'}
                              catalogPending={
                                config.subConfig![slot].filter(key => key !== 'catalogName')
                                  .length === 0 ||
                                launchSubPreview(
                                  {
                                    ...config.subConfig!,
                                    [slot]: config.subConfig![slot].filter(
                                      key => key !== 'catalogName'
                                    )
                                  },
                                  config.creativeAlias,
                                  localSources
                                )[slot] !== null
                              }
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

          <section
            className="launch-editor-section launch-editor-campaigns"
            aria-labelledby={`${prefix}-campaigns-heading`}
          >
            <div className="launch-editor-section-heading">
              <div>
                <h3 id={`${prefix}-campaigns-heading`}>{t('launchesSectionCampaigns')}</h3>
              </div>
            </div>
            <div className="launch-editor-fields-row">
              <div className="launch-editor-counts">
                {number('campaignCount', 'launchesCampaignCount')}
                {number('adsCount', 'launchesAdsCount')}
              </div>
              <div className="launch-editor-budget">
                <span className="ui-field-label">
                  {t(
                    config.campaignCount === 1 ? 'launchesBudgetSingle' : 'launchesBudgetMultiple'
                  )}
                </span>
                <div className="launch-editor-budget-row">
                  <FormField label={t('launchSettingsBudget')}>
                    <SegmentedControl
                      label={t('launchesBudgetMode')}
                      size="sm"
                      value={config.budgetMode ?? 'auto'}
                      disabled={disabled}
                      options={[
                        { value: 'auto', label: t('launchesAutomatic') },
                        { value: 'manual', label: t('launchesCustomBudgets') },
                        { value: 'single', label: t('launchesSingleBudget') }
                      ]}
                      onChange={mode => {
                        if (mode === 'single')
                          changed({ budgetMode: 'single', budgets: null, minBudget: undefined });
                        else if (mode === 'auto' || mode === 'manual')
                          if (mode === 'auto') changed({ budgetMode: 'auto', budgets: null });
                          else {
                            const manual =
                              manualBudgetDraft.length === (config.campaignCount ?? 0)
                                ? manualBudgetDraft
                                : budgets.length && config.budgetMode !== 'single'
                                  ? budgets
                                  : Array.from(
                                      {
                                        length:
                                          Number.isInteger(config.campaignCount) &&
                                          config.campaignCount! >= 1 &&
                                          config.campaignCount! <= 100
                                            ? config.campaignCount!
                                            : 0
                                      },
                                      () => 0
                                    );
                            setManualBudgetDraft(manual);
                            changed({
                              budgetMode: 'manual',
                              budgets: manual,
                              minBudget: manual[0] > 0 ? manual[0] : undefined,
                              ...(manual.length ? { maxBudget: Math.max(...manual) } : {})
                            });
                          }
                      }}
                    />
                  </FormField>
                  {config.budgetMode === 'single' ? (
                    number('maxBudget', 'launchesBudgetPerCampaign', '$')
                  ) : config.budgetMode !== 'manual' ? (
                    <>
                      {number('minBudget', 'launchesMinBudget', '$')}
                      {number(
                        'maxBudget',
                        'launchesBudgetMaximum',
                        '$',
                        undefined,
                        budgets.length > 0 ? (
                          <output
                            className="launch-editor-budget-preview"
                            aria-label={t('launchesBudget')}
                          >
                            {budgets.slice(0, 4).map((budget, index) => (
                              <span key={index}>
                                {budget} <span className="launch-editor-budget-currency">$</span>
                              </span>
                            ))}
                            {budgets.length > 4 && (
                              <span
                                aria-label={t('launchSettingsMoreBudgets', {
                                  count: budgets.length - 4
                                })}
                              >
                                +{budgets.length - 4}
                              </span>
                            )}
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
                            invalid={budgetError}
                            aria-describedby={budgetError ? `${prefix}-budget-error` : undefined}
                            onChange={e => {
                              const manual = [...budgets];
                              manual[i] = Number(e.target.value);
                              setManualBudgetDraft(manual);
                              changed({
                                budgetMode: 'manual',
                                budgets: manual,
                                minBudget: manual[0] > 0 ? manual[0] : undefined,
                                maxBudget: Math.max(...manual)
                              });
                            }}
                          />
                        ))}
                      </div>
                    )
                  )}
                </div>
                {budgetError && (
                  <p
                    id={`${prefix}-budget-error`}
                    className="ui-field-error launch-editor-budget-error"
                    role="alert"
                  >
                    {t(
                      config.budgetMode === 'single'
                        ? 'launchesMaxBudgetInvalid'
                        : config.budgetMode === 'manual'
                          ? 'launchesBudgetInvalid'
                          : 'launchesBudgetRangeInvalid'
                    )}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section
            className="launch-editor-section launch-editor-method"
            aria-labelledby={`${prefix}-method-heading`}
          >
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
                      changed({
                        catalog: {
                          ...config.catalog!,
                          restitchEnabled,
                          ...(config.catalog!.catalogVideoProtocolVersion === 1 && !restitchEnabled
                            ? { videoVariationCount: 1 }
                            : {})
                        }
                      })
                    }
                  />
                </div>
                <Suspense fallback={null}>
                  <LaunchCatalogVideoFields
                    part="variations"
                    value={config.catalog}
                    disabled={disabled}
                    onChange={catalog => changed({ catalog })}
                  />
                </Suspense>
                <CatalogVideoR2Toggle
                  mode="create"
                  teamId={teamId}
                  control="switch"
                  checked={config.catalog!.copyVideoToR2 === true}
                  disabled={disabled}
                  onChange={copyVideoToR2 =>
                    changed({ catalog: { ...config.catalog!, copyVideoToR2 } })
                  }
                />
                {config.catalog.restitchEnabled && (
                  <LaunchRestitchDurationField
                    value={config.catalog}
                    disabled={disabled}
                    error={
                      errors.customFinalDurationSeconds && (submitted || touched.has('catalog'))
                        ? t('launchesDurationInvalid')
                        : undefined
                    }
                    onChange={duration => changed({ catalog: { ...config.catalog!, ...duration } })}
                  />
                )}
                <Accordion
                  className="launch-editor-catalog-advanced"
                  openIds={
                    catalogAdvancedOpen || (submitted && invalidCatalog)
                      ? new Set(['catalog-advanced'])
                      : new Set()
                  }
                  onToggle={() => setCatalogAdvancedOpen(open => !open)}
                  items={[
                    {
                      id: 'catalog-advanced',
                      title: t('launchSettingsAdvancedCatalog'),
                      content: (
                        <div className="launch-editor-advanced-content">
                          <Suspense fallback={null}>
                            <LaunchCatalogVideoFields
                              part="publication"
                              value={config.catalog!}
                              disabled={disabled}
                              onChange={catalog => changed({ catalog })}
                            />
                          </Suspense>
                        </div>
                      )
                    }
                  ]}
                />
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

          <LaunchNotesEditor
            notes={config.notes ?? []}
            disabled={disabled}
            onChange={notes => changed({ notes })}
          />
        </fieldset>
      </Card>
      <LaunchPreview value={null} rows={previewRows} />
    </div>
  );
}
