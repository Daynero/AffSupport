import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Search, X } from 'lucide-react';
import type {
  CatalogRegistryRow,
  CatalogUpdaterInterval,
  CatalogUpdaterState
} from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox, IconButton, SegmentedControl } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { catalogSelectedCountKey, useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { UpdaterCountdown } from './UpdaterCountdown';
import {
  filterCatalogRows,
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from './useCatalogUpdater';
import {
  RestitchDevicePicker,
  type RestitchAgentClient,
  type RestitchDeviceClient
} from './RestitchDevicePicker';

export interface CatalogUpdaterDialogClient extends CatalogUpdaterClient, RestitchDeviceClient {
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
  agentClient,
  onClose,
  onChanged
}: {
  teamId: string;
  client?: CatalogUpdaterDialogClient;
  agentClient?: RestitchAgentClient;
  onClose: () => void;
  /** Called after a start, save or stop, so the chip outside the dialog reads the new state. */
  onChanged?: () => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const titleId = useId();
  const searchId = useId();
  const mayRun = can('process');

  const updater = useCatalogUpdater(teamId, client);
  const registry = useCatalogRegistry(teamId, true, client);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [interval, setIntervalChoice] = useState<CatalogUpdaterInterval>('1h');
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
  const canSubmit = mayRun && liveChosen.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await client.saveCatalogUpdater(teamId, {
        catalogIds: liveChosen,
        interval,
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

  const copy = async (row: CatalogRegistryRow) => {
    try {
      await navigator.clipboard.writeText(row.sheetUrl);
      push({ tone: 'success', text: t('catalogUpdaterCopied') });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
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
                  <small>
                    {row.folderName ?? t('catalogUpdaterSpaceRoot')} ·{' '}
                    {t('catalogUpdaterProducts', { count: row.productCount })} ·{' '}
                    {t('catalogUpdaterCreated', { date: when(row.createdAt) })} ·{' '}
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
                <div className="team-updater-row-actions">
                  <a
                    className="icon-button"
                    href={row.sheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('catalogUpdaterOpenFor', { name: row.name })}
                    title={t('catalogUpdaterOpenFor', { name: row.name })}
                  >
                    <ExternalLink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </a>
                  <IconButton
                    label={t('catalogUpdaterCopyFor', { name: row.name })}
                    onClick={() => void copy(row)}
                  >
                    <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="team-updater-footer">
        <div className="team-updater-options">
          <SegmentedControl
            label={t('catalogUpdaterIntervalLabel')}
            value={interval}
            disabled={!mayRun || busy}
            options={[
              { value: '1h', label: t('catalogUpdaterInterval1h') },
              { value: '1d', label: t('catalogUpdaterInterval1d') },
              { value: '1w', label: t('catalogUpdaterInterval1w') }
            ]}
            onChange={setIntervalChoice}
          />
          <RestitchDevicePicker
            teamId={teamId}
            state={updater.state}
            restitch={restitch}
            disabled={!mayRun || busy}
            client={client}
            agentClient={agentClient}
            onRestitchChange={setRestitch}
            onEnrolled={() => {
              updater.reload();
              onChanged?.();
            }}
          />
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
