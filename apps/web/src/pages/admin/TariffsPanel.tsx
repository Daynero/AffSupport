import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Plus, Settings } from 'lucide-react';
import type {
  AdminLegacySpace,
  AdminSpaceRequest,
  AdminTariffRow,
  AdminTariffSettings,
  AdminTariffState,
  TariffPlan
} from '@video-compressor/shared';
import { adminTariffApi, searchAdminUsers, type AdminTariffClient } from '../../api/team';
import { analytics } from '../../analytics/service';
import { useToasts } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  SearchField,
  SegmentedControl,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  User,
  type UiColor
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../../team/errors';
import { formatTariffDay, formatTariffShortDay } from '../../team/tariffs/format';
import { TariffEditDialog } from './TariffEditDialog';
import { TariffEndDialog } from './TariffEndDialog';
import { TariffGrantDialog, type GrantPrefill } from './TariffGrantDialog';
import { TariffHistoryDrawer } from './TariffHistoryDrawer';
import { TariffLegacySpaces } from './TariffLegacySpaces';
import { TariffRequests } from './TariffRequests';
import { TariffSettingsDialog } from './TariffSettingsDialog';
import { TariffsSkeleton } from './TariffsSkeleton';
import {
  TARIFF_FILTERS,
  addMonthsPreview,
  extendBase,
  filterCounts,
  matchesFilter,
  matchesSearch,
  sortTariffs,
  type TariffFilter
} from './tariffModel';

/**
 * «Тарифи» — the administrator's ledger of who has a space and until when
 * (034, US3). The admin page opens on it.
 *
 * One line says what needs attention; the filters answer "what ends this week"
 * in one press (SC-005); a row extends by a month in one press with an undo;
 * requests and the spaces still on the old rule are views of the same table
 * rather than pages of their own.
 */

const STATE_BADGE: Record<AdminTariffState, { key: TranslationKey; color: UiColor }> = {
  active: { key: 'tariffStateActive', color: 'success' },
  expiring: { key: 'tariffStateExpiring', color: 'warning' },
  grace: { key: 'tariffStateGrace', color: 'error' },
  blocked: { key: 'tariffStatePaused', color: 'neutral' },
  pending: { key: 'tariffStatePending', color: 'info' },
  pending_expired: { key: 'tariffStatePendingExpired', color: 'neutral' },
  legacy: { key: 'tariffStateLegacy', color: 'secondary' },
  internal: { key: 'tariffStateInternal', color: 'neutral' }
};

const FILTER_LABEL: Record<TariffFilter, TranslationKey> = {
  all: 'adminTariffFilterAll',
  le7: 'adminTariffFilter7',
  le3: 'adminTariffFilter3',
  grace: 'adminTariffFilterGrace',
  blocked: 'adminTariffFilterBlocked',
  pending: 'adminTariffFilterPending',
  legacy: 'adminTariffFilterLegacy',
  requests: 'adminTariffFilterRequests'
};

const defaultClient: AdminTariffClient = { ...adminTariffApi, searchUsers: searchAdminUsers };

interface Loaded {
  rows: AdminTariffRow[];
  plans: TariffPlan[];
  requests: AdminSpaceRequest[];
  legacy: AdminLegacySpace[];
  settings: AdminTariffSettings;
}

export function TariffsPanel({ client = defaultClient }: { client?: AdminTariffClient }) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<TariffFilter>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [granting, setGranting] = useState<GrantPrefill | null>(null);
  const [editing, setEditing] = useState<AdminTariffRow | null>(null);
  const [ending, setEnding] = useState<AdminTariffRow | null>(null);
  const [history, setHistory] = useState<AdminTariffRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [rows, plans, requests, legacy, settings] = await Promise.all([
        client.listTariffs(),
        client.listPlans(),
        client.listRequests(),
        client.listLegacySpaces(),
        client.getSettings()
      ]);
      setData({ rows, plans, requests, legacy, settings });
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => (data ? filterCounts(data.rows, data.requests, data.legacy.length) : null),
    [data]
  );
  const visible = useMemo(
    () =>
      data
        ? sortTariffs(
            data.rows.filter(row => matchesFilter(row, filter) && matchesSearch(row, query))
          )
        : [],
    [data, filter, query]
  );

  if (failed && !data) {
    return (
      <ErrorState message={t('adminError')} onRetry={() => void load()} retryLabel={t('retry')} />
    );
  }
  if (!data || !counts) return <TariffsSkeleton />;

  const planName = (code: string, fallback: string) => {
    const plan = data.plans.find(item => item.code === code);
    return plan ? (language === 'uk' ? plan.nameUk : plan.nameEn) : fallback;
  };

  const extend = async (row: AdminTariffRow) => {
    setBusyId(row.id);
    try {
      const updated = await client.extend(row.id, 1);
      await load();
      push({
        tone: 'info',
        text: t('adminTariffExtended', {
          email: row.ownerEmail,
          date: formatTariffDay(updated.endsOn, language, updated.tariffToday)
        }),
        ...(updated.eventId
          ? {
              action: {
                label: t('adminTariffUndo'),
                run: async () => {
                  try {
                    await client.undo(updated.eventId!);
                    push({ tone: 'success', text: t('adminTariffUndone') });
                  } catch (cause) {
                    push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
                  }
                  await load();
                }
              }
            }
          : {})
      });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusyId(null);
    }
  };

  const markRequest = async (request: AdminSpaceRequest, handled: boolean) => {
    setBusyId(request.userId);
    try {
      await client.markRequest(request.userId, handled);
      await load();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusyId(null);
    }
  };

  const granted = async (row: AdminTariffRow, prefill: GrantPrefill) => {
    setGranting(null);
    analytics.track('space_tariff_granted', { source_kind: prefill.source });
    push({
      tone: 'success',
      text: t('adminTariffGranted', {
        email: row.ownerEmail,
        date: formatTariffDay(row.endsOn, language, row.tariffToday)
      })
    });
    if (prefill.requestUserId) {
      await client.markRequest(prefill.requestUserId, true).catch(() => undefined);
    }
    await load();
  };

  const contactMissing = !data.settings.telegram && !data.settings.email;
  const summary = [
    t('adminTariffSummary7', { count: counts.le7 }),
    t('adminTariffSummaryGrace', { count: counts.grace }),
    t('adminTariffSummaryRequests', { count: counts.requests })
  ].join(' · ');

  return (
    <div className="admin-tariffs flex flex-col gap-4">
      <Card className="admin-card" aria-labelledby="admin-tariffs-heading">
        <div className="admin-card-heading flex-wrap">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 id="admin-tariffs-heading">{t('adminTabTariffs')}</h3>
            <p className="m-0 text-label text-ink-muted">{summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              color="neutral"
              variant="outline"
              leading={<Settings size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => setSettingsOpen(true)}
            >
              {t('adminTariffSettingsTitle')}
            </Button>
            <Button
              color="primary"
              leading={<Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => setGranting({ source: 'manual' })}
            >
              {t('adminTariffGrant')}
            </Button>
          </div>
        </div>

        {contactMissing && (
          <Alert
            color="warning"
            variant="subtle"
            action={
              <Button
                size="sm"
                color="neutral"
                variant="outline"
                onClick={() => setSettingsOpen(true)}
              >
                {t('adminTariffSettingsTitle')}
              </Button>
            }
          >
            {t('adminTariffContactMissing')}
          </Alert>
        )}

        <div className="admin-tariff-toolbar">
          <SegmentedControl
            size="sm"
            label={t('adminTariffFilters')}
            value={filter}
            options={TARIFF_FILTERS.map(value => ({
              value,
              label: (
                <span className="flex items-center gap-1">
                  {t(FILTER_LABEL[value])}
                  <span className="text-ink-muted numeric">{counts[value]}</span>
                </span>
              )
            }))}
            onChange={setFilter}
          />
          <SearchField
            size="sm"
            value={query}
            onChange={setQuery}
            placeholder={t('adminTariffSearch')}
            aria-label={t('adminTariffSearch')}
            className="admin-tariff-search"
          />
        </div>

        {filter === 'requests' ? (
          <TariffRequests
            requests={data.requests.filter(
              request =>
                !query.trim() ||
                `${request.email} ${request.name ?? ''}`
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase())
            )}
            plans={data.plans}
            busyId={busyId}
            onGrant={request =>
              setGranting({
                source: 'request',
                email: request.email,
                plan: request.planInterest,
                requestUserId: request.userId
              })
            }
            onMark={(request, handled) => void markRequest(request, handled)}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            size="sm"
            className="admin-empty"
            title={t(query.trim() ? 'adminTariffNothingFound' : 'adminTariffEmpty')}
          />
        ) : (
          <Table
            size="sm"
            className="admin-table admin-tariff-table"
            columns="minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 0.7fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(10rem, 1.8fr)"
            label={t('adminTabTariffs')}
          >
            <TableHeader>
              <TableHeaderCell>{t('adminTariffOwner')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffSpace')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffPlan')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffSeats')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffUntil')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffDaysLeft')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffState')}</TableHeaderCell>
              <TableHeaderCell>{t('adminTariffNote')}</TableHeaderCell>
              <TableHeaderCell>
                <span className="visually-hidden">{t('adminTariffActions')}</span>
              </TableHeaderCell>
            </TableHeader>
            {visible.map(row => (
              <TariffRow
                key={row.id}
                row={row}
                plan={planName(row.planCode, row.planNameUk)}
                busy={busyId === row.id}
                onExtend={() => void extend(row)}
                onEdit={() => setEditing(row)}
                onEnd={() => setEnding(row)}
                onHistory={() => setHistory(row)}
              />
            ))}
          </Table>
        )}

        {filter === 'legacy' && (
          <TariffLegacySpaces
            spaces={data.legacy}
            onGrant={space =>
              setGranting({
                source: 'legacy',
                email: space.ownerEmail ?? '',
                teamId: space.teamId
              })
            }
          />
        )}
      </Card>

      {granting && (
        <TariffGrantDialog
          plans={data.plans}
          tariffToday={data.settings.tariffToday}
          prefill={granting}
          requests={data.requests}
          client={client}
          onClose={() => setGranting(null)}
          onGranted={(row, prefill) => void granted(row, prefill)}
        />
      )}
      {editing && (
        <TariffEditDialog
          row={editing}
          plans={data.plans}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push({ tone: 'success', text: t('adminTariffSaved') });
            void load();
          }}
          onShowSeats={row => {
            setEditing(null);
            setHistory(row);
          }}
        />
      )}
      {ending && (
        <TariffEndDialog
          row={ending}
          client={client}
          onClose={() => setEnding(null)}
          onEnded={() => {
            setEnding(null);
            push({ tone: 'success', text: t('adminTariffEnded') });
            void load();
          }}
        />
      )}
      {history && (
        <TariffHistoryDrawer
          row={history}
          client={client}
          onClose={() => setHistory(null)}
          onChanged={() => void load()}
        />
      )}
      {settingsOpen && (
        <TariffSettingsDialog
          settings={data.settings}
          client={client}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            push({ tone: 'success', text: t('adminTariffSaved') });
            void load();
          }}
        />
      )}
    </div>
  );
}

function daysLabel(
  row: AdminTariffRow,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  language: 'en' | 'uk'
): string {
  switch (row.state) {
    case 'blocked':
    case 'internal':
      return '—';
    case 'pending_expired':
      return t('adminTariffDaysExpired');
    case 'grace':
      return t('adminTariffDaysGrace', { date: formatTariffShortDay(row.graceUntil, language) });
    default:
      if (row.daysLeft <= 0) return t('adminTariffDaysToday');
      if (row.daysLeft === 1) return t('adminTariffDaysTomorrow');
      return t('adminTariffDaysCount', { count: row.daysLeft });
  }
}

function TariffRow({
  row,
  plan,
  busy,
  onExtend,
  onEdit,
  onEnd,
  onHistory
}: {
  row: AdminTariffRow;
  plan: string;
  busy: boolean;
  onExtend: () => void;
  onEdit: () => void;
  onEnd: () => void;
  onHistory: () => void;
}) {
  const { t, language } = useI18n();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const badge = STATE_BADGE[row.state];
  const revoked = row.revokedAt !== null;
  const waiting = row.state === 'pending' || row.state === 'pending_expired';
  const nextEnd = addMonthsPreview(extendBase(row), 1);

  return (
    <TableRow busy={busy}>
      <TableCell>
        <User name={row.ownerEmail} meta={row.ownerName ?? undefined} />
      </TableCell>
      <TableCell>{row.teamName ?? '—'}</TableCell>
      <TableCell>{plan}</TableCell>
      <TableCell>
        {/* No space yet, so nobody can hold a seat: the plan's size is the useful number. */}
        {row.teamId ? (
          <span className="numeric">
            {t('adminTariffSeatsValue', { used: row.seatsUsed, total: row.seatsTotal })}
          </span>
        ) : (
          <span className="numeric text-ink-muted">{row.seatsTotal}</span>
        )}
      </TableCell>
      <TableCell>{formatTariffShortDay(row.endsOn, language)}</TableCell>
      <TableCell>{daysLabel(row, t, language)}</TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          <Badge size="xs" color={badge.color}>
            {t(badge.key)}
          </Badge>
          {row.legacyAlso && row.state !== 'legacy' && (
            <Badge size="xs" color="secondary" variant="subtle">
              {t('tariffStateLegacy')}
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell>
        {row.note ? (
          <span className="admin-tariff-note" title={row.note}>
            {row.note}
          </span>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell>
        <span className="flex items-center justify-end gap-1">
          {/* A grant still waiting for its first sign-in is extended the same way: the deal
              was made, the person is just late to log in. */}
          <Button size="sm" color="neutral" variant="outline" loading={busy} onClick={onExtend}>
            {t('adminTariffExtendTo', { date: formatTariffShortDay(nextEnd, language) })}
          </Button>
          <IconButton
            ref={menuAnchor}
            label={t('adminTariffActionsFor', { email: row.ownerEmail })}
            size="sm"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(current => !current)}
          >
            <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
          <DropdownMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={menuAnchor}
            label={t('adminTariffActionsFor', { email: row.ownerEmail })}
            items={[
              ...(revoked ? [] : [{ id: 'edit', label: t('adminTariffEdit'), onSelect: onEdit }]),
              {
                id: 'history',
                label: row.teamId ? t('adminTariffHistoryAndSeats') : t('adminTariffHistory'),
                onSelect: onHistory
              },
              ...(revoked
                ? []
                : [
                    'separator' as const,
                    {
                      id: 'end',
                      label: waiting ? t('adminTariffCancelGrant') : t('adminTariffEnd'),
                      destructive: true,
                      onSelect: onEnd
                    }
                  ])
            ]}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}
