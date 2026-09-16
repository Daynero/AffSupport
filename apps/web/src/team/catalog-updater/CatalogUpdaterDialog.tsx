import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, Timer, X } from 'lucide-react';
import type { CatalogUpdaterInterval, CatalogUpdaterState } from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { catalogSelectedCountKey, useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { UpdaterCountdown } from './UpdaterCountdown';
import { UpdaterRowActions } from './UpdaterRowActions';
import {
  filterCatalogRows,
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from './useCatalogUpdater';
import { customIntervalFromHours, isUpdaterPreset } from './limits';

export interface CatalogUpdaterDialogClient extends CatalogUpdaterClient {
  saveCatalogUpdater: (
    teamId: string,
    input: { catalogIds: string[]; interval: CatalogUpdaterInterval; restitch: boolean }
  ) => Promise<CatalogUpdaterState>;
  stopCatalogUpdater: (teamId: string) => Promise<CatalogUpdaterState>;
}

const defaultClient: CatalogUpdaterDialogClient = teamApi;

/**
 * The catalog updater (023, US1/US2/US4): every catalog in the space, the ones the updater renews,
 * how often, and start / save / stop — in one full-screen dialog that lives in the address, like
 * the space settings, so Back closes it and a pasted link opens it.
 */
export function CatalogUpdaterDialog({
  teamId,
  client = defaultClient,
  preparing = false,
  onClose,
  onChanged
}: {
  teamId: string;
  client?: CatalogUpdaterDialogClient;
  /** This tab is preparing a re-stitched copy right now. */
  preparing?: boolean;
  onClose: () => void;
  /** Called after a start, save or stop, so the chip outside the dialog reads the new state. */
  onChanged?: () => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { can, permissions } = useTeam();
  const titleId = useId();
  const searchId = useId();
  const mayRun = can('process');

  const updater = useCatalogUpdater(teamId, client);
  const registry = useCatalogRegistry(teamId, true, client);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [interval, setIntervalChoice] = useState<CatalogUpdaterInterval>('1h');
  // The hours field while "own interval" is chosen; a preset clears the choice, not the text.
  const [customMode, setCustomMode] = useState(false);
  const [customHours, setCustomHours] = useState('');
  const customInterval = customIntervalFromHours(customHours);
  const [restitch, setRestitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const selectAllRef = useRef<HTMLSpanElement>(null);

  const running = updater.state?.state === 'running';

  // The first reads decide the starting selection and interval; later refreshes never overwrite
  // what the person has ticked since.
  useEffect(() => {
    if (selected !== null || !registry.rows || !updater.state) return;
    setSelected(new Set(registry.rows.filter(row => row.inUpdater).map(row => row.catalogId)));
    setIntervalChoice(updater.state.interval);
    if (!isUpdaterPreset(updater.state.interval)) {
      setCustomMode(true);
      setCustomHours(updater.state.interval.slice(0, -1));
    }
    setRestitch(updater.state.restitch);
  }, [registry.rows, selected, updater.state]);

  const rows = registry.rows ?? [];
  const shown = useMemo(() => filterCatalogRows(rows, query), [rows, query]);
  const chosen = selected ?? new Set<string>();
  const shownChosen = shown.filter(row => chosen.has(row.catalogId)).length;
  const allShownChosen = shown.length > 0 && shownChosen === shown.length;

  useEffect(() => {
    const input = selectAllRef.current?.querySelector('input');
    if (input) input.indeterminate = shownChosen > 0 && !allShownChosen;
  }, [allShownChosen, shownChosen]);

  const toggle = (catalogId: string) =>
    setSelected(current => {
      const next = new Set(current ?? []);
      if (next.has(catalogId)) next.delete(catalogId);
      else next.add(catalogId);
      return next;
    });

  const toggleShown = () =>
    setSelected(current => {
      const next = new Set(current ?? []);
      for (const row of shown) {
        if (allShownChosen) next.delete(row.catalogId);
        else next.add(row.catalogId);
      }
      return next;
    });

  // Only catalogs that still exist count: a ticked catalog that disappeared is not sent.
  const liveChosen = rows.filter(row => chosen.has(row.catalogId)).map(row => row.catalogId);
  const chosenInterval = customMode ? customInterval : interval;
  const canSubmit = mayRun && liveChosen.length > 0 && !busy && chosenInterval !== null;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await client.saveCatalogUpdater(teamId, {
        catalogIds: liveChosen,
        interval: chosenInterval!,
        restitch
      });
      push({
        tone: 'success',
        text: t(running ? 'catalogUpdaterSaved' : 'catalogUpdaterStarted')
      });
      updater.reload();
      registry.reload();
      onChanged?.();
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setConfirmingStop(false);
    setBusy(true);
    try {
      await client.stopCatalogUpdater(teamId);
      push({ tone: 'success', text: t('catalogUpdaterStopped') });
      setSelected(new Set());
      updater.reload();
      registry.reload();
      onChanged?.();
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusy(false);
    }
  };

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }),
    [language]
  );
  const when = (iso: string) => dateFormat.format(new Date(iso));

  const status = running ? (
    <p className="team-updater-status" role="status">
      {t('catalogUpdaterStatusRunningPrefix')}{' '}
      <UpdaterCountdown
        targetIso={updater.state?.nextRunAt ?? null}
        offsetMs={updater.offsetMs}
        dueLabel={t('catalogUpdaterChipDue')}
      />
    </p>
  ) : (
    <p className="team-updater-status" role="status">
      {t('catalogUpdaterStatusStopped')}
    </p>
  );

  const reason = !mayRun
    ? t('catalogUpdaterNoPermission')
    : liveChosen.length === 0
      ? t('catalogUpdaterNothingSelected')
      : null;

  return (
    <Modal
      bare
      labelledBy={titleId}
      onClose={onClose}
      backdropClassName="team-updater-backdrop"
      className="team-updater-dialog"
      initialFocus={`[id="${searchId}"]`}
    >
      <header className="team-updater-header">
        <div>
          <h2 id={titleId}>{t('catalogUpdaterTitle')}</h2>
          {status}
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('catalogUpdaterClose')}
        </Button>
      </header>

      <div className="team-updater-toolbar">
        <label className="team-task-picker-search team-updater-search" htmlFor={searchId}>
          <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder={t('catalogUpdaterSearch')}
            aria-label={t('catalogUpdaterSearch')}
            onChange={event => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="team-task-picker-search-clear"
              aria-label={t('catalogUpdaterClearSearch')}
              onClick={() => setQuery('')}
            >
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
        </label>
        <span ref={selectAllRef} className="team-updater-select-all">
          <Checkbox
            checked={allShownChosen}
            disabled={!mayRun || shown.length === 0}
            onChange={toggleShown}
            label={t('catalogUpdaterSelectAll')}
          />
        </span>
        <span className="team-updater-selected" aria-live="polite">
          {t(catalogSelectedCountKey(language, liveChosen.length), { count: liveChosen.length })}
        </span>
      </div>

      <div className="team-updater-list">
        {registry.rows === null && !registry.error && (
          <p className="team-updater-empty">{t('catalogUpdaterLoading')}</p>
        )}
        {registry.error && registry.rows === null && (
          <p className="team-inline-error">{t('catalogUpdaterLoadFailed')}</p>
        )}
        {registry.rows !== null && rows.length === 0 && (
          <p className="team-updater-empty">{t('catalogUpdaterEmpty')}</p>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <p className="team-updater-empty">{t('catalogUpdaterNoMatches')}</p>
        )}
        {shown.length > 0 && (
          <ul className="team-updater-rows">
            {shown.map(row => (
              <li key={row.catalogId} className="team-updater-row">
                <label className="team-explorer-row-check team-explorer-check">
                  <input
                    type="checkbox"
                    checked={chosen.has(row.catalogId)}
                    disabled={!mayRun}
                    aria-label={t('catalogUpdaterSelectFor', { name: row.videoName })}
                    onChange={() => toggle(row.catalogId)}
                  />
                  <span />
                </label>
                <div className="team-updater-row-main">
                  <strong>{row.videoName}</strong>
                  {/* Two facts, the ones an updater is read for: where it is, and
                      when it was last brought up to date. The count and the
                      creation date are one hover away (024, T131). */}
                  <small
                    title={`${t('catalogUpdaterProducts', { count: row.productCount })} · ${t(
                      'catalogUpdaterCreated',
                      { date: when(row.createdAt) }
                    )}`}
                  >
                    {row.folderName ?? t('catalogUpdaterSpaceRoot')} ·{' '}
                    {row.lastUpdatedAt
                      ? t('catalogUpdaterUpdated', { date: when(row.lastUpdatedAt) })
                      : t('catalogUpdaterNeverUpdated')}
                  </small>
                  {row.lastUpdateError && (
                    <small className="team-inline-error">
                      {t('catalogUpdaterLastFailed')}:{' '}
                      {teamErrorMessageFor({ code: row.lastUpdateError }, t)}
                    </small>
                  )}
                </div>
                {row.inUpdater && (
                  <span className="ui-chip team-updater-badge">{t('catalogUpdaterInUpdater')}</span>
                )}
                {permissions ? (
                  <UpdaterRowActions
                    row={row}
                    teamId={teamId}
                    permissions={permissions}
                    onChanged={() => registry.reload()}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="team-updater-footer">
        <div className="team-updater-options">
          <div className="team-updater-interval">
            <div
              className="fit-mode-pictos"
              role="group"
              aria-label={t('catalogUpdaterIntervalLabel')}
            >
              {(
                [
                  ['1h', t('catalogUpdaterInterval1h')],
                  ['1d', t('catalogUpdaterInterval1d')],
                  ['1w', t('catalogUpdaterInterval1w')]
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`is-labeled${!customMode && interval === value ? ' is-selected' : ''}`}
                  disabled={!mayRun || busy}
                  aria-pressed={!customMode && interval === value}
                  onClick={() => {
                    setCustomMode(false);
                    setIntervalChoice(value);
                  }}
                >
                  <span>{label}</span>
                </button>
              ))}
              <button
                type="button"
                className={customMode ? 'is-selected' : ''}
                disabled={!mayRun || busy}
                data-tip={t('catalogUpdaterIntervalCustom')}
                aria-label={t('catalogUpdaterIntervalCustom')}
                aria-pressed={customMode}
                onClick={() => setCustomMode(true)}
              >
                <Timer size={20} strokeWidth={1.75} />
              </button>
            </div>
            {customMode && (
              <div className="custom-duration-input">
                <input
                  className={`time-input ${customHours && !customInterval ? 'is-invalid' : ''}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="6"
                  value={customHours}
                  disabled={!mayRun || busy}
                  aria-label={t('catalogUpdaterIntervalHours')}
                  aria-invalid={customInterval === null}
                  onChange={event => setCustomHours(event.target.value)}
                />
                <span>{t('catalogUpdaterHoursUnit')}</span>
              </div>
            )}
            {customMode && customInterval === null && (
              <span className="soty-field-error">{t('catalogUpdaterIntervalInvalid')}</span>
            )}
          </div>
          <div className="team-updater-restitch">
            <Checkbox
              checked={restitch}
              // Until the first reads land, the effect above would overwrite a tick made meanwhile.
              disabled={!mayRun || busy || selected === null}
              onChange={event => setRestitch(event.target.checked)}
              label={t('catalogUpdaterRestitch')}
            />
            <small>{t('catalogUpdaterRestitchHint')}</small>
            {running && updater.state?.restitch && updater.state.spareReadyCount !== null && (
              <small>
                {t('catalogUpdaterSparesReady', {
                  ready: updater.state.spareReadyCount,
                  count: updater.state.catalogCount
                })}
              </small>
            )}
            {preparing && <small>{t('catalogUpdaterPreparingHere')}</small>}
          </div>
        </div>
        <div className="team-dialog-actions">
          {reason && <p className="field-hint team-updater-reason">{reason}</p>}
          {running && (
            <Button
              type="button"
              variant="danger"
              disabled={!mayRun || busy}
              onClick={() => setConfirmingStop(true)}
            >
              {t('catalogUpdaterStop')}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {t(running ? 'catalogUpdaterSave' : 'catalogUpdaterStart')}
          </Button>
        </div>
      </footer>

      {confirmingStop && (
        <Modal
          nested
          size="sm"
          labelledBy={`${titleId}-stop`}
          onClose={() => setConfirmingStop(false)}
          closeLabel={t('catalogUpdaterCancel')}
        >
          <div className="team-dialog-form">
            <h2 id={`${titleId}-stop`}>{t('catalogUpdaterStopTitle')}</h2>
            <p>{t('catalogUpdaterStopBody')}</p>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setConfirmingStop(false)}>
                {t('catalogUpdaterCancel')}
              </Button>
              <Button type="button" variant="danger" onClick={() => void stop()}>
                {t('catalogUpdaterStop')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
