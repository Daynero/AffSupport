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
  launchCreativeLabel,
  isLaunchUrl,
  missingLaunchSubSlots,
  rescaleCopies,
  type LaunchCreative,
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
  SegmentedControl,
  Collapse
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { LaunchDictionaryManager } from './LaunchDictionaryManager';
import { LaunchAccountSelector } from './LaunchAccountSelector';
import { LaunchSelector } from './LaunchSelectors';
import { LaunchCreativePicker } from './LaunchCreativePicker';
import { creativesPatch, draftCreatives, withVariationCount } from './launchCreatives';
import { teamErrorMessageFor } from '../errors';
import { LaunchRestitchDurationField } from './LaunchRestitchDurationField.js';
import { SubBuilder } from './SubBuilder';
import { LaunchPreview } from './LaunchPreview';
import { LaunchBudgetPreview } from './LaunchBudgetPreview';
import { LaunchDateField } from './LaunchDateField';
import { launchPixel } from './launchPixel';
import { newLaunchCatalogConfig } from './launchCatalogDefaults';
import { CatalogVideoR2Toggle } from '../product-catalog/CatalogVideoR2Toggle';
import { prefetchCatalogVideoR2Availability } from '../product-catalog/useCatalogVideoR2Availability';
import { teamApi } from '../../api/team';

/** As long as the flash on a field with an error (launch-settings.css). */
const ATTENTION_MS = 1_600;
const loadCatalogVideoFields = () => import('./LaunchCatalogVideoFields');
const LaunchCatalogVideoFields = lazy(() =>
  loadCatalogVideoFields().then(module => ({
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
  sourceNotice,
  submitted = false,
  submitAttempt = 0
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
  /** A question the sources raised — the offer's saved settings — asked right under them. */
  sourceNotice?: ReactNode;
  submitted?: boolean;
  /** Counts presses of «Згенерувати запуск», so every press, not only the first, finds the error. */
  submitAttempt?: number;
}) {
  const { t } = useI18n();
  const prefix = useId();
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [subSettingsOpen, setSubSettingsOpen] = useState(false);
  const [productsBelowCreatives, setProductsBelowCreatives] = useState(false);
  const [productText, setProductText] = useState<string | null>(null);
  // The split before a count was being typed, so each keystroke scales from it.
  const typingBase = useRef<LaunchCreative[] | null>(null);
  const [keptFirstCreative, setKeptFirstCreative] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [manualBudgetDraft, setManualBudgetDraft] = useState<number[]>(config.budgets ?? []);
  const editorRef = useRef<HTMLDivElement>(null);
  // The catalog shelf's lazy part is fetched with the editor, not when the shelf opens: it
  // popped in a beat after the rest of the shelf (next QA 2026-11-21).
  useEffect(() => {
    void loadCatalogVideoFields();
    prefetchCatalogVideoR2Availability(teamId, teamApi.catalogVideoR2);
  }, [teamId]);
  useEffect(() => {
    if (config.budgetMode === 'manual' && config.budgets) setManualBudgetDraft([...config.budgets]);
  }, [config.budgetMode, config.budgets]);
  useEffect(() => {
    if (!submitted) return;
    // Every press of «Згенерувати запуск» lands on the first error that can be seen — not one
    // inside a folded or hidden part of the form, which scrolled to «a field that is not
    // there» — puts the cursor in its field and flashes it (next QA 2026-11-21).
    const frame = requestAnimationFrame(() => {
      const firstError = [
        ...(editorRef.current?.querySelectorAll<HTMLElement>('.ui-field-error') ?? [])
      ].find(error => !error.closest('[hidden], [inert], [aria-hidden="true"]'));
      if (!firstError) return;
      // Errors set beside their fields (budgets, products) have no field around them.
      const target = firstError.closest<HTMLElement>('.ui-field') ?? firstError.parentElement;
      if (!target) return;
      target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      target
        .querySelector<HTMLElement>(
          '[aria-invalid="true"], input:not([type="hidden"]):not(:disabled), textarea, button:not(:disabled)'
        )
        ?.focus({ preventScroll: true });
      target.classList.remove('is-attention');
      void target.offsetWidth;
      target.classList.add('is-attention');
      window.setTimeout(() => target.classList.remove('is-attention'), ATTENTION_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [submitted, submitAttempt]);
  const changed = (patch: LaunchDraft) => {
    setTouched(previous => new Set([...previous, ...Object.keys(patch)]));
    onChange(patch);
  };
  const creativeCount = draftCreatives(config).length;
  const creativeKind =
    config.creativeKind ?? (creativeCount > 0 ? (sources?.materialType ?? 'video') : null);
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
  // One SUB «Креатив» for the whole Launch: the name typed for several creatives, else the
  // first creative with «+N» for the others.
  const subPreview = config.subConfig
    ? launchSubPreview(
        config.subConfig,
        config.creativeAlias
          ? launchCreativeLabel({
              creativeAlias: config.creativeAlias,
              creatives: config.method === 'catalog' ? config.creatives : undefined,
              creativeLabel: config.creativeLabel
            })
          : config.creativeAlias,
        localSources
      )
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
  // Before the error below is decided: budgets that are each valid but cannot all differ
  // (30 campaigns between 5 $ and 30 $) were caught only after it, so the preview went
  // blank with no word why (next QA 2026-11-21).
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
  // An automatic range too narrow for one budget per campaign is said as such: «the minimum
  // cannot exceed the maximum» was the only message, and here it is not the reason.
  const campaignCount = config.campaignCount ?? 0;
  const narrowRange =
    (config.budgetMode ?? 'auto') === 'auto' &&
    Number.isSafeInteger(campaignCount) &&
    campaignCount > 1 &&
    Number.isSafeInteger(config.maxBudget) &&
    (config.minBudget === undefined
      ? config.maxBudget! < campaignCount
      : Number.isSafeInteger(config.minBudget) &&
        config.minBudget >= 1 &&
        config.minBudget <= config.maxBudget! &&
        config.maxBudget! - config.minBudget < campaignCount - 1);
  const budgetKeys = ['minBudget', 'maxBudget', 'budgets'];
  const productCountError =
    config.method === 'catalog' &&
    productText === null &&
    Boolean(errors.productCount) &&
    (submitted || touched.has('catalog'));
  const budgetError =
    !editingBudget &&
    budgetKeys.some(key => Boolean(errors[key])) &&
    (submitted || budgetKeys.some(key => touched.has(key)));
  const emptyValue = (key: string) => {
    const value = (config as Record<string, unknown>)[key];
    return value === undefined || value === null || value === '';
  };
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
                  : // «Потрібно заповнити» for an empty field and only for it: 101 campaigns,
                    // typed, was called missing, and an unchosen РК «Перевірте значення»
                    // (next QA 2026-11-21).
                    !emptyValue(key)
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
  const previewRows = launchNamingPreview(config, localSources);
  const missingSubSlots = isLaunchUrl(config.originalUrl)
    ? missingLaunchSubSlots(config.originalUrl)
    : [];
  const pixel = launchPixel(config.originalUrl);
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
            {sourceNotice}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <SegmentedControl
                label={t('launchesMethod')}
                disabled={disabled}
                value={config.method ?? 'other'}
                options={[
                  { value: 'catalog', label: t('launchesCatalog') },
                  { value: 'other', label: t('launchesOther') }
                ]}
                onChange={method => {
                  if (method === 'catalog' || method === 'other') {
                    const chosen = draftCreatives(config);
                    // "Other" takes one creative: the first stays, the list is dropped.
                    setKeptFirstCreative(method === 'other' && chosen.length > 1);
                    changed({
                      method,
                      ...(method === 'other'
                        ? {
                            creatives: undefined,
                            creativeKind: undefined,
                            creativeLabel: undefined
                          }
                        : {}),
                      ...(method === 'catalog' && !config.catalog
                        ? { catalog: newLaunchCatalogConfig() }
                        : {})
                    });
                  }
                }}
              />
              {config.method === 'catalog' && config.catalog && (
                <>
                  <label className="launch-editor-appear flex items-center gap-2 text-label text-ink-muted">
                    {t('launchSettingsProducts')}
                    <Input
                      id={`${prefix}-productCount`}
                      aria-label={t('launchesCatalogProductCount')}
                      invalid={productCountError}
                      aria-describedby={
                        productCountError ? `${prefix}-productCount-error` : undefined
                      }
                      type="number"
                      width="narrow"
                      value={productText ?? config.catalog.productCount}
                      min={Math.max(1, creativeCount)}
                      max={400}
                      disabled={disabled}
                      onChange={e => {
                        if (creativeCount <= 1) {
                          changed({
                            catalog: { ...config.catalog!, productCount: Number(e.target.value) }
                          });
                          return;
                        }
                        // Several creatives: what is typed is committed only once it is a
                        // whole count the creatives fit in, so an intermediate "1" on the way
                        // to "100" does not wipe a custom split. Fewer than the creatives is
                        // refused with the reason.
                        if (productText === null) typingBase.current = draftCreatives(config);
                        setProductText(e.target.value);
                        const typed = Number(e.target.value);
                        const whole = e.target.value !== '' && Number.isSafeInteger(typed);
                        setProductsBelowCreatives(whole && typed < creativeCount);
                        if (whole && typed >= creativeCount && typed <= 400)
                          changed(
                            creativesPatch(
                              config,
                              rescaleCopies(typingBase.current ?? draftCreatives(config), typed),
                              creativeKind,
                              typed
                            )
                          );
                      }}
                      onBlur={() => {
                        if (productText === null) return;
                        const typed = Number(productText);
                        // Leaving the field below the creatives settles on the smallest count
                        // that fits them; anything else unusable returns to the saved count.
                        if (
                          productText !== '' &&
                          Number.isSafeInteger(typed) &&
                          typed < creativeCount
                        )
                          changed(
                            creativesPatch(
                              config,
                              rescaleCopies(draftCreatives(config), creativeCount),
                              creativeKind,
                              creativeCount
                            )
                          );
                        setProductText(null);
                        typingBase.current = null;
                      }}
                    />
                  </label>
                  {productsBelowCreatives ? (
                    <p className="ui-field-error basis-full" role="alert">
                      {t('launchProductsBelowCreatives')}
                    </p>
                  ) : (
                    // The count sits beside the method, outside the shared field: 0 or 401
                    // products said nothing until generation refused them (next QA 2026-11-21).
                    productCountError && (
                      <p
                        id={`${prefix}-productCount-error`}
                        className="ui-field-error basis-full"
                        role="alert"
                      >
                        {t('launchesProductCountInvalid')}
                      </p>
                    )
                  )}
                </>
              )}
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
                {submitted && errors.creatives && errors.creatives !== 'DISTRIBUTION_INVALID' && (
                  <p className="ui-field-error" role="alert">
                    {teamErrorMessageFor({ code: errors.creatives }, t)}
                  </p>
                )}
                {keptFirstCreative && config.method === 'other' && (
                  <p className="ui-field-help">{t('launchOtherMethodOneCreative')}</p>
                )}
              </div>
              <div className="launch-editor-link-field">
                {pixel && (
                  // The buyer checks which pixel a launch fires before it goes out; the
                  // link is too long to find fb_pixel in by eye.
                  <span className="launch-editor-pixel" title={pixel}>
                    {t('launchesPixel', { pixel })}
                  </span>
                )}
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
                <p className="launch-editor-url-warning" role="status" aria-live="polite">
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
                          <LaunchBudgetPreview
                            budgets={budgets}
                            label={t('launchesBudget')}
                            moreLabel={count => t('launchSettingsMoreBudgets', { count })}
                          />
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
                    {narrowRange
                      ? config.minBudget === undefined
                        ? t('launchesBudgetMaxBelowCampaigns', { count: campaignCount })
                        : t('launchesBudgetRangeTooNarrow', {
                            count: campaignCount,
                            gap: campaignCount - 1
                          })
                      : t(
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

          {/* Always mounted, so «Каталог» opens the shelf from nothing and «Без каталогу» folds
              it away instead of cutting it (next QA 2026-11-21). The catalog settings stay in
              the draft under «Без каталогу», which is what is shown while it closes. */}
          <Collapse open={config.method === 'catalog'} className="launch-editor-collapse">
            {config.catalog && (
              <section
                className="launch-editor-section launch-editor-method"
                aria-labelledby={`${prefix}-method-heading`}
              >
                <div className="launch-editor-section-heading">
                  <div>
                    <h3 id={`${prefix}-method-heading`}>{t('launchesCatalog')}</h3>
                  </div>
                </div>
                {config.catalog && (
                  <div className="launch-editor-catalog-options">
                    <div className="launch-editor-catalog-switches">
                      {/* One row per option, each as tall as its tallest control from the start, so
                          a switch never moves under the pointer: turning re-stitch on used to add a
                          labelled field above the row and drop the switch a line down (next QA
                          2026-11-21). What an option adds appears beside it, in its row or in the column
                          to the right. */}
                      {creativeKind !== 'image' && (
                        <div className="launch-editor-catalog-row">
                          <div className="launch-editor-restitch">
                            <Switch
                              label={t('launchesRestitch')}
                              checked={config.catalog.restitchEnabled}
                              disabled={disabled}
                              onChange={restitchEnabled => {
                                const current = config.catalog!;
                                // Turning restitch on with several videos starts at one variation per
                                // video, the least the launch accepts — not at an error the user did
                                // not make. Turning it off returns a v1 catalog to its one original.
                                const next = { ...current, restitchEnabled };
                                changed({
                                  catalog:
                                    restitchEnabled &&
                                    creativeCount > 1 &&
                                    (current.videoVariationCount ?? 1) < creativeCount
                                      ? withVariationCount(
                                          next,
                                          Math.min(creativeCount, current.productCount)
                                        )
                                      : !restitchEnabled &&
                                          current.catalogVideoProtocolVersion === 1
                                        ? { ...next, videoVariationCount: 1 }
                                        : next
                                });
                              }}
                            />
                          </div>
                          {config.catalog.restitchEnabled && (
                            <div className="launch-editor-variations launch-editor-appear">
                              <Suspense fallback={null}>
                                <LaunchCatalogVideoFields
                                  part="variations"
                                  value={config.catalog}
                                  disabled={disabled}
                                  creativeCopies={
                                    creativeCount > 1
                                      ? draftCreatives(config).map(c => c.copies)
                                      : undefined
                                  }
                                  onChange={catalog => changed({ catalog })}
                                />
                              </Suspense>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="launch-editor-catalog-row">
                        <CatalogVideoR2Toggle
                          mode="create"
                          teamId={teamId}
                          control="switch"
                          media={creativeKind === 'image' ? 'image' : 'video'}
                          checked={config.catalog!.copyVideoToR2 === true}
                          disabled={disabled}
                          onChange={copyVideoToR2 =>
                            changed({ catalog: { ...config.catalog!, copyVideoToR2 } })
                          }
                        />
                      </div>
                      <div className="launch-editor-catalog-publication flex basis-full flex-col gap-2">
                        <Suspense fallback={null}>
                          <LaunchCatalogVideoFields
                            part="publication"
                            media={creativeKind === 'image' ? 'image' : 'video'}
                            value={config.catalog!}
                            disabled={disabled}
                            onChange={catalog => changed({ catalog })}
                          />
                        </Suspense>
                        {creativeKind === 'image' && scheduledPublication && (
                          <p className="ui-field-help">{t('launchImagesScheduleHint')}</p>
                        )}
                      </div>
                    </div>
                    {/* The duration takes the half of the shelf the switches leave empty. */}
                    {creativeKind !== 'image' && (
                      <Collapse
                        open={config.catalog.restitchEnabled}
                        className="launch-editor-catalog-fold"
                      >
                        <LaunchRestitchDurationField
                          value={config.catalog}
                          disabled={disabled}
                          error={
                            errors.customFinalDurationSeconds &&
                            (submitted || touched.has('catalog'))
                              ? t('launchesDurationInvalid')
                              : undefined
                          }
                          onChange={duration =>
                            changed({ catalog: { ...config.catalog!, ...duration } })
                          }
                        />
                      </Collapse>
                    )}
                  </div>
                )}
              </section>
            )}
          </Collapse>

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
