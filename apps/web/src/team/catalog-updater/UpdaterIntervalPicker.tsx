import { useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock3 } from 'lucide-react';
import type { CatalogUpdateSchedule } from '@video-compressor/shared';
import { TeamApiError, type CatalogUpdaterInterval } from '../../api/team';
import { Button, Input, Popover } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { customIntervalFromHours, isUpdaterPreset, type UpdaterPreset } from './limits';
import { catalogNextRunPreview } from './catalogSchedulePreview';

const PRESETS: ReadonlyArray<[UpdaterPreset, TranslationKey]> = [
  ['1h', 'catalogUpdaterEveryHour'],
  ['1d', 'catalogUpdaterEveryDay'],
  ['1w', 'catalogUpdaterEveryWeek']
];

export function intervalLabel(
  interval: CatalogUpdaterInterval | null | 'mixed',
  t: ReturnType<typeof useI18n>['t']
): string {
  if (interval === 'mixed') return t('catalogUpdaterMixed');
  if (interval === null) return t('catalogUpdaterOff');
  const preset = PRESETS.find(([value]) => value === interval);
  return preset ? t(preset[1]) : t('catalogUpdaterEveryHours', { count: interval.slice(0, -1) });
}

function defaultSchedule(): CatalogUpdateSchedule {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekday: 1, time: '09:00' };
}

/** Preserve the user's existing cadence when upgrading a legacy interval to a wall clock. */
function legacySchedule(
  interval: CatalogUpdaterInterval | null | 'mixed',
  nextRunAt?: string | null
): CatalogUpdateSchedule {
  const fallback = defaultSchedule();
  if ((interval !== '1d' && interval !== '1w') || !nextRunAt) return fallback;
  const next = new Date(nextRunAt);
  if (!Number.isFinite(next.getTime())) return fallback;
  return {
    timeZone: fallback.timeZone,
    weekday: next.getDay() || 7,
    time: `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  };
}

function scheduleFingerprint(
  value: CatalogUpdaterInterval | null | 'mixed',
  schedule?: CatalogUpdateSchedule | null
): string {
  return `${value ?? ''}|${schedule?.timeZone ?? ''}|${schedule?.weekday ?? ''}|${schedule?.time ?? ''}`;
}

/** Draft a schedule in one compact panel, then save the complete choice once. */
export function UpdaterIntervalPicker({
  value,
  label,
  disabled,
  alwaysNotify = false,
  offActionLabel,
  nextLabel,
  nextTitle,
  nextRunAt,
  schedule,
  onSaveSchedule,
  onChange
}: {
  value: CatalogUpdaterInterval | null | 'mixed';
  label: string;
  disabled?: boolean;
  alwaysNotify?: boolean;
  offActionLabel?: string;
  nextLabel?: string;
  nextTitle?: string;
  nextRunAt?: string | null;
  schedule?: CatalogUpdateSchedule | null;
  onSaveSchedule?: (
    interval: CatalogUpdaterInterval | null,
    schedule: CatalogUpdateSchedule | null
  ) => Promise<void>;
  onChange: (next: CatalogUpdaterInterval | null) => void;
}) {
  const { t, language } = useI18n();
  const anchor = useRef<HTMLDivElement>(null);
  const hoursId = useId();
  const timeId = useId();
  const timeInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<UpdaterPreset | 'custom'>('1d');
  const [hours, setHours] = useState('');
  const [draftSchedule, setDraftSchedule] = useState<CatalogUpdateSchedule>({
    timeZone: 'UTC',
    weekday: 1,
    time: '09:00'
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveLock = useRef(false);
  const baseline = useRef<string | null>(null);
  const custom = customIntervalFromHours(hours);
  const nextInterval = preset === 'custom' ? custom : preset;
  const calendarSchedule = Boolean(onSaveSchedule && (preset === '1d' || preset === '1w'));
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/u.test(draftSchedule.time);
  const weekdayFormatters = useMemo(
    () =>
      open
        ? {
            short: new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
              weekday: 'short'
            }),
            full: new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
              weekday: 'long'
            })
          }
        : null,
    [open, language]
  );
  const resetDraft = () => {
    baseline.current = scheduleFingerprint(value, schedule);
    setPreset(value && value !== 'mixed' ? (isUpdaterPreset(value) ? value : 'custom') : '1d');
    setHours(value && value !== 'mixed' && !isUpdaterPreset(value) ? value.slice(0, -1) : '6');
    setDraftSchedule(schedule ?? legacySchedule(value, nextRunAt));
    setError(null);
  };
  const save = async (interval: CatalogUpdaterInterval | null) => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError(null);
    try {
      if (onSaveSchedule && baseline.current !== scheduleFingerprint(value, schedule)) {
        throw new TeamApiError('STALE_RESULT', false);
      }
      if (onSaveSchedule)
        await onSaveSchedule(
          interval,
          interval === '1d' || interval === '1w' ? draftSchedule : null
        );
      else if (alwaysNotify || interval !== value) await onChange(interval);
      setOpen(false);
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  const originalSchedule = open ? (schedule ?? legacySchedule(value, nextRunAt)) : draftSchedule;
  const unchangedSchedule =
    open &&
    nextInterval === value &&
    (!calendarSchedule ||
      (draftSchedule.timeZone === originalSchedule.timeZone &&
        draftSchedule.time === originalSchedule.time &&
        (preset !== '1w' || draftSchedule.weekday === originalSchedule.weekday)));
  const previewAt =
    open && nextInterval && (!calendarSchedule || validTime)
      ? catalogNextRunPreview(nextInterval, calendarSchedule ? draftSchedule : null)
      : null;
  const preview = previewAt ? new Date(previewAt) : null;
  const formatNext = (date: Date, timeZone?: string) => {
    try {
      const locale = language === 'uk' ? 'uk-UA' : 'en-US';
      const day = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        timeZone
      }).format(date);
      const time = new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone
      }).format(date);
      return `${day}, ${time}`;
    } catch {
      return undefined;
    }
  };
  const savedNext = unchangedSchedule
    ? nextRunAt && Number.isFinite(Date.parse(nextRunAt))
      ? formatNext(new Date(nextRunAt), originalSchedule.timeZone)
      : nextTitle
    : undefined;
  const previewLabel =
    savedNext ?? (preview ? formatNext(preview, draftSchedule.timeZone) : undefined);
  const kyivZone = ['Europe/Kyiv', 'Europe/Kiev'].includes(draftSchedule.timeZone);
  const zoneCity = kyivZone
    ? t('catalogScheduleKyivZone')
    : draftSchedule.timeZone.split('/').at(-1)?.replaceAll('_', ' ');
  const zoneLabel = kyivZone
    ? t('catalogScheduleKyivTime')
    : t('catalogScheduleZoneTime', { zone: draftSchedule.timeZone });

  return (
    <div ref={anchor} className="team-updater-interval-picker">
      <Button
        type="button"
        size="sm"
        variant={value === null || value === 'mixed' ? 'ghost' : 'secondary'}
        disabled={disabled || saving}
        aria-label={`${label}: ${intervalLabel(value, t)}${nextLabel ? ` · ${nextLabel}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={value === null ? 'is-off' : value === 'mixed' ? undefined : 'is-scheduled'}
        onClick={() => {
          if (!open) resetDraft();
          setOpen(current => !current);
        }}
      >
        <span className="catalog-schedule-label">
          {intervalLabel(value, t)}
          {nextLabel && <small title={nextTitle}>{nextLabel}</small>}
        </span>
        <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </Button>
      <Popover
        open={open}
        onClose={() => {
          if (!saveLock.current) setOpen(false);
        }}
        anchor={anchor}
        placement="bottom-end"
        frequent
        label={label}
        className="team-updater-interval-menu catalog-schedule-panel"
      >
        {open && (
          <form
            onSubmit={event => {
              event.preventDefault();
              if (nextInterval && (!calendarSchedule || validTime)) void save(nextInterval);
            }}
          >
            <div className="catalog-schedule-presets" role="group" aria-label={label}>
              {PRESETS.map(([option, key]) => (
                <button
                  key={option}
                  type="button"
                  className={`catalog-schedule-preset ${preset === option ? 'is-selected' : ''}`.trim()}
                  aria-pressed={preset === option}
                  disabled={saving}
                  onClick={() => {
                    setPreset(option);
                    setError(null);
                  }}
                >
                  <span>{t(key)}</span>
                </button>
              ))}
              <button
                type="button"
                className={`catalog-schedule-preset ${preset === 'custom' ? 'is-selected' : ''}`.trim()}
                aria-pressed={preset === 'custom'}
                disabled={saving}
                onClick={() => {
                  setPreset('custom');
                  setError(null);
                }}
              >
                <span>{t('catalogScheduleCustom')}</span>
              </button>
            </div>
            <div
              className={`catalog-schedule-fields ${onSaveSchedule && preset === '1w' ? 'is-weekly' : ''}`.trim()}
            >
              {preset === 'custom' && (
                <div className="team-updater-interval-custom">
                  <label htmlFor={hoursId}>{t('catalogUpdaterEvery')}</label>
                  <Input
                    id={hoursId}
                    size="sm"
                    width="narrow"
                    type="text"
                    inputMode="numeric"
                    value={hours}
                    disabled={saving}
                    aria-label={t('catalogUpdaterIntervalHours')}
                    aria-invalid={hours !== '' && custom === null}
                    onChange={event =>
                      setHours(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))
                    }
                  />
                  <span>{t('catalogUpdaterHoursUnit')}</span>
                  {hours !== '' && custom === null && (
                    <small className="soty-field-error">{t('catalogUpdaterIntervalInvalid')}</small>
                  )}
                </div>
              )}
              {onSaveSchedule && preset === '1w' && (
                <div className="catalog-schedule-weekday-field">
                  <span>{t('catalogScheduleWeekday')}</span>
                  <div
                    className="catalog-schedule-weekdays"
                    role="group"
                    aria-label={t('catalogScheduleWeekday')}
                  >
                    {Array.from({ length: 7 }, (_, index) => {
                      const weekday = (index + 1) as CatalogUpdateSchedule['weekday'];
                      const day = new Date(2026, 5, 1 + index, 12);
                      return (
                        <button
                          key={weekday}
                          type="button"
                          className={`catalog-schedule-weekday ${draftSchedule.weekday === weekday ? 'is-selected' : ''}`.trim()}
                          aria-label={weekdayFormatters!.full.format(day)}
                          aria-pressed={draftSchedule.weekday === weekday}
                          disabled={saving}
                          onClick={() => setDraftSchedule(current => ({ ...current, weekday }))}
                        >
                          {weekdayFormatters!.short
                            .format(day)
                            .replace(/^./u, letter => letter.toUpperCase())}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {calendarSchedule && (
                <div className="catalog-schedule-time">
                  <label htmlFor={timeId} className="catalog-schedule-time-label">
                    {t('catalogScheduleTime')}
                    <small className="catalog-schedule-zone" title={zoneLabel}>
                      · {zoneCity}
                    </small>
                  </label>
                  <Input
                    id={timeId}
                    aria-label={t('catalogScheduleTime')}
                    aria-describedby={`${timeId}-zone`}
                    ref={timeInput}
                    type="time"
                    trailing={
                      <button
                        type="button"
                        className="catalog-schedule-time-open"
                        aria-label={t('catalogScheduleOpenTime')}
                        disabled={saving}
                        onClick={() => {
                          timeInput.current?.focus();
                          timeInput.current?.showPicker?.();
                        }}
                      >
                        <ChevronDown
                          size={ICON_SIZE}
                          strokeWidth={ICON_STROKE}
                          aria-hidden="true"
                        />
                      </button>
                    }
                    size="sm"
                    width="narrow"
                    value={draftSchedule.time}
                    disabled={saving}
                    onChange={event =>
                      setDraftSchedule(current => ({ ...current, time: event.target.value }))
                    }
                  />
                  <span id={`${timeId}-zone`} className="sr-only">
                    {zoneLabel}
                  </span>
                </div>
              )}
            </div>
            <div className="catalog-schedule-feedback">
              {previewLabel && !error && (
                <p className="catalog-schedule-preview" title={draftSchedule.timeZone}>
                  <Clock3 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  <span>
                    {t('catalogScheduleNextPreview', { date: '' })}
                    <strong>{previewLabel}</strong>
                  </span>
                </p>
              )}
              {error && (
                <p className="catalog-schedule-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="catalog-schedule-footer">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void save(null)}
              >
                {offActionLabel ?? t('catalogScheduleDisable')}
              </Button>
              <Button
                type="submit"
                size="lg"
                className="catalog-schedule-save"
                variant="solid"
                color="secondary"
                disabled={saving || !nextInterval || Boolean(calendarSchedule && !validTime)}
              >
                {t(saving ? 'catalogScheduleSaving' : 'catalogScheduleSave')}
              </Button>
            </div>
          </form>
        )}
      </Popover>
    </div>
  );
}
