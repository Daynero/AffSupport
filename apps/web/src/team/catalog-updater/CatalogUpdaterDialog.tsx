import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import type {
  CatalogRegistryRow,
  CatalogUpdaterInterval,
  CatalogUpdaterState
} from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Checkbox } from '../../components/ui';
import { Button, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { catalogSelectedCountKey, useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { UpdaterCountdown } from './UpdaterCountdown';
import { UpdaterIntervalPicker } from './UpdaterIntervalPicker';
import { UpdaterRowActions } from './UpdaterRowActions';
import {
  filterCatalogRows,
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from './useCatalogUpdater';

export interface CatalogUpdaterDialogClient extends CatalogUpdaterClient {
  setCatalogUpdateInterval: (
    teamId: string,
    catalogIds: string[],
    interval: CatalogUpdaterInterval | null
  ) => Promise<CatalogUpdaterState>;
  runCatalogUpdateNow: (teamId: string, catalogIds: string[]) => Promise<number>;
  setCatalogUpdaterRestitch: (teamId: string, restitch: boolean) => Promise<CatalogUpdaterState>;
  getCatalogUpdaterRefreshImages?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRefreshImages?: (teamId: string, refresh: boolean) => Promise<boolean>;
  getCatalogUpdaterRefreshTexts?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRefreshTexts?: (teamId: string, refresh: boolean) => Promise<boolean>;
  getCatalogUpdaterGrow?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterGrow?: (teamId: string, grow: boolean) => Promise<boolean>;
}

const defaultClient: CatalogUpdaterDialogClient = teamApi;

/**
 * The catalog updater (023; a schedule per catalog in 024).
 *
 * Every catalog in the space is a row that carries its own schedule and its own "update now". It
 * was one interval for the space and a Start, Save and Stop to learn: a catalog that needed hourly
 * updates dragged every other one to hourly, and renewing one sheet this minute was not possible
 * at all. Choosing an interval is saving it; "Off" is how a catalog leaves the schedule. Ticking
 * rows gives the same two controls for all of them at once, the way Airtable edits a field across
 * a selection.
 *
 * The dialog lives in the address, like the space settings, so Back closes it and a link opens it.
 */
export function CatalogUpdaterDialog({
  teamId,
  client = defaultClient,
  preparing = false,
  onClose,
  onChanged,
  onReveal
}: {
  teamId: string;
  client?: CatalogUpdaterDialogClient;
  /** This tab is preparing a re-stitched copy right now. */
  preparing?: boolean;
  onClose: () => void;
  /** Called after a change, so the chip outside the dialog reads the new state. */
  onChanged?: () => void;
  /** Close the updater and show this catalog's sheet where it lives in the space. */
  onReveal?: (row: CatalogRegistryRow) => void;
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Rows with a change on its way, so their controls wait instead of taking a second press. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const selectAllRef = useRef<HTMLSpanElement>(null);

  const running = updater.state?.state === 'running';
  const rows = registry.rows ?? [];
  const shown = useMemo(() => filterCatalogRows(rows, query), [rows, query]);
  const liveSelected = rows.filter(row => selected.has(row.catalogId));
  const shownChosen = shown.filter(row => selected.has(row.catalogId)).length;
  const allShownChosen = shown.length > 0 && shownChosen === shown.length;

  useEffect(() => {
    const input = selectAllRef.current?.querySelector('input');
    if (input) input.indeterminate = shownChosen > 0 && !allShownChosen;
  }, [allShownChosen, shownChosen]);

  const toggle = (catalogId: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(catalogId)) next.delete(catalogId);
      else next.add(catalogId);
      return next;
    });

  const toggleShown = () =>
    setSelected(current => {
      const next = new Set(current);
      for (const row of shown) {
        if (allShownChosen) next.delete(row.catalogId);
        else next.add(row.catalogId);
      }
      return next;
    });

  const withBusy = async (ids: string[], work: () => Promise<void>) => {
    setBusyIds(current => new Set([...current, ...ids]));
    try {
      await work();
      updater.reload();
      registry.reload();
      onChanged?.();
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setBusyIds(current => new Set([...current].filter(id => !ids.includes(id))));
    }
  };

  const schedule = (ids: string[], interval: CatalogUpdaterInterval | null) =>
    withBusy(ids, async () => {
      await client.setCatalogUpdateInterval(teamId, ids, interval);
    });

  const updateNow = (ids: string[]) =>
    withBusy(ids, async () => {
      const opened = await client.runCatalogUpdateNow(teamId, ids);
      push({
        tone: 'success',
        text:
          opened === 0
            ? t('catalogUpdaterNowAlready')
            : t('catalogUpdaterNowStarted', { count: opened })
      });
    });

  /*
   * New pictures at every update (024), on unless turned off: a catalog whose rows keep the same
   * white pictures week after week is the one part of it that never changes.
   */
  const [refreshImages, setRefreshImages] = useState<boolean | null>(null);
  useEffect(() => {
    if (!client.getCatalogUpdaterRefreshImages) return;
    let active = true;
    void client
      .getCatalogUpdaterRefreshImages(teamId)
      .then(value => {
        if (active) setRefreshImages(value);
      })
      .catch(() => {
        if (active) setRefreshImages(true);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);
  const changeRefreshImages = async (next: boolean) => {
    if (!client.setCatalogUpdaterRefreshImages) return;
    setRefreshImages(next);
    try {
      setRefreshImages(await client.setCatalogUpdaterRefreshImages(teamId, next));
    } catch (error) {
      setRefreshImages(!next);
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    }
  };

  /**
   * New names, texts and prices at every update (024, US21), on unless turned off: pictures alone left
   * the same hundred products under the same hundred names, at the same price, week after week.
   */
  const [refreshTexts, setRefreshTexts] = useState<boolean | null>(null);
  useEffect(() => {
    if (!client.getCatalogUpdaterRefreshTexts) return;
    let active = true;
    void client
      .getCatalogUpdaterRefreshTexts(teamId)
      .then(value => {
        if (active) setRefreshTexts(value);
      })
      .catch(() => {
        if (active) setRefreshTexts(true);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);
  const changeRefreshTexts = async (next: boolean) => {
    if (!client.setCatalogUpdaterRefreshTexts) return;
    setRefreshTexts(next);
    try {
      setRefreshTexts(await client.setCatalogUpdaterRefreshTexts(teamId, next));
    } catch (error) {
      setRefreshTexts(!next);
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    }
  };

  /**
   * A few more products at every update (024 US22), off unless asked for: a catalog that has held
   * the same hundred products for a month is a catalog Meta has already seen. Off by default —
   * this one grows the sheet, and a sheet cannot grow past four hundred.
   */
  const [grow, setGrow] = useState<boolean | null>(null);
  useEffect(() => {
    if (!client.getCatalogUpdaterGrow) return;
    let active = true;
    void client
      .getCatalogUpdaterGrow(teamId)
      .then(value => {
        if (active) setGrow(value);
      })
      .catch(() => {
        if (active) setGrow(false);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);
  const changeGrow = async (next: boolean) => {
    if (!client.setCatalogUpdaterGrow) return;
    setGrow(next);
    try {
      setGrow(await client.setCatalogUpdaterGrow(teamId, next));
    } catch (error) {
      setGrow(!next);
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    }
  };

  const setRestitch = (restitch: boolean) =>
    withBusy([], async () => {
      await client.setCatalogUpdaterRestitch(teamId, restitch);
    });

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
      {t('catalogUpdaterStatusScheduled', { count: updater.state?.catalogCount ?? 0 })}{' '}
      <UpdaterCountdown
        targetIso={updater.state?.nextRunAt ?? null}
        offsetMs={updater.offsetMs}
        dueLabel={t('catalogUpdaterChipDue')}
      />
    </p>
  ) : (
    <p className="team-updater-status" role="status">
      {t('catalogUpdaterStatusNone')}
    </p>
  );

  const rowFacts = (row: CatalogRegistryRow) => {
    if (row.updatePending) return t('catalogUpdaterUpdatingNow');
    const where = row.folderName ?? t('catalogUpdaterSpaceRoot');
    return `${where} · ${
      row.lastUpdatedAt
        ? t('catalogUpdaterUpdated', { date: when(row.lastUpdatedAt) })
        : t('catalogUpdaterNeverUpdated')
    }`;
  };

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
        {mayRun && (
          <span ref={selectAllRef} className="team-updater-select-all">
            <Checkbox
              checked={allShownChosen}
              disabled={shown.length === 0}
              onChange={toggleShown}
              label={t('catalogUpdaterSelectAll')}
            />
          </span>
        )}
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
            {shown.map(row => {
              const busy = busyIds.has(row.catalogId);
              return (
                <li
                  key={row.catalogId}
                  className={`team-updater-row${selected.has(row.catalogId) ? ' is-selected' : ''}`}
                >
                  {mayRun ? (
                    <label className="team-explorer-row-check team-explorer-check">
                      <input
                        type="checkbox"
                        checked={selected.has(row.catalogId)}
                        aria-label={t('catalogUpdaterSelectFor', { name: row.name })}
                        onChange={() => toggle(row.catalogId)}
                      />
                      <span />
                    </label>
                  ) : (
                    <span />
                  )}
                  <div className="team-updater-row-main">
                    {/* The catalog's own name, not its video's: two variations of one
                        video were two rows with the same label (024, FR-106). */}
                    <strong title={row.videoName}>{row.name}</strong>
                    <small
                      className={row.updatePending ? 'is-pending' : undefined}
                      title={`${t('catalogUpdaterProducts', { count: row.productCount })} · ${t(
                        'catalogUpdaterCreated',
                        { date: when(row.createdAt) }
                      )}`}
                    >
                      {rowFacts(row)}
                      {row.inUpdater && row.nextRunAt && !row.updatePending && (
                        <>
                          {' · '}
                          {t('catalogUpdaterNextIn')}{' '}
                          <UpdaterCountdown
                            targetIso={row.nextRunAt}
                            offsetMs={updater.offsetMs}
                            dueLabel={t('catalogUpdaterChipDue')}
                          />
                        </>
                      )}
                    </small>
                    {row.lastUpdateError && (
                      <small className="team-inline-error">
                        {t('catalogUpdaterLastFailed')}:{' '}
                        {teamErrorMessageFor({ code: row.lastUpdateError }, t)}
                      </small>
                    )}
                  </div>
                  <div className="team-updater-row-schedule">
                    <UpdaterIntervalPicker
                      value={row.updateInterval}
                      label={t('catalogUpdaterIntervalFor', { name: row.name })}
                      disabled={!mayRun || busy}
                      onChange={next => void schedule([row.catalogId], next)}
                    />
                    {mayRun && (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label={t('catalogUpdaterNowFor', { name: row.name })}
                        disabled={busy || row.updatePending}
                        className={row.updatePending ? 'is-spinning' : undefined}
                        onClick={() => void updateNow([row.catalogId])}
                      >
                        <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      </IconButton>
                    )}
                  </div>
                  {permissions ? (
                    <UpdaterRowActions
                      row={row}
                      teamId={teamId}
                      permissions={permissions}
                      onChanged={() => registry.reload()}
                      onReveal={onReveal}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="team-updater-footer">
        {liveSelected.length > 0 ? (
          /* The same two controls a row has, for every ticked row. */
          <div className="team-updater-bulk" role="group" aria-label={t('catalogUpdaterBulkLabel')}>
            <span className="team-updater-selected" aria-live="polite">
              {t(catalogSelectedCountKey(language, liveSelected.length), {
                count: liveSelected.length
              })}
            </span>
            <UpdaterIntervalPicker
              value={null}
              label={t('catalogUpdaterIntervalForSelected')}
              disabled={busyIds.size > 0}
              onChange={next =>
                void schedule(
                  liveSelected.map(row => row.catalogId),
                  next
                )
              }
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busyIds.size > 0}
              onClick={() => void updateNow(liveSelected.map(row => row.catalogId))}
            >
              <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('catalogUpdaterNow')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('catalogUpdaterClearSelection')}
            </Button>
          </div>
        ) : (
          <p className="field-hint team-updater-reason">
            {mayRun ? t('catalogUpdaterHowTo') : t('catalogUpdaterNoPermission')}
          </p>
        )}
        {/* What an update changes, as one group (024, US23): four ticks that each repeated "at
            every update" in their own label, under a heading that says it once. */}
        <fieldset className="team-updater-choices">
          <legend>{t('catalogUpdaterChangesTitle')}</legend>
          {refreshImages !== null && (
            <div className="team-updater-restitch">
              <Checkbox
                checked={refreshImages}
                disabled={!mayRun}
                onChange={event => void changeRefreshImages(event.target.checked)}
                label={t('catalogUpdaterRefreshImages')}
              />
              <small>{t('catalogUpdaterRefreshImagesHint')}</small>
            </div>
          )}
          {refreshTexts !== null && (
            <div className="team-updater-restitch">
              <Checkbox
                checked={refreshTexts}
                disabled={!mayRun}
                onChange={event => void changeRefreshTexts(event.target.checked)}
                label={t('catalogUpdaterRefreshTexts')}
              />
              <small>{t('catalogUpdaterRefreshTextsHint')}</small>
            </div>
          )}
          {grow !== null && (
            <div className="team-updater-restitch">
              <Checkbox
                checked={grow}
                disabled={!mayRun}
                onChange={event => void changeGrow(event.target.checked)}
                label={t('catalogUpdaterGrow')}
              />
              <small>{t('catalogUpdaterGrowHint')}</small>
            </div>
          )}
          <div className="team-updater-restitch">
            <Checkbox
              checked={updater.state?.restitch ?? false}
              disabled={!mayRun || updater.state === null || busyIds.size > 0}
              onChange={event => void setRestitch(event.target.checked)}
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
        </fieldset>
      </footer>
    </Modal>
  );
}
