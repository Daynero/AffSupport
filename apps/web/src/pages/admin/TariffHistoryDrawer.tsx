import { useCallback, useEffect, useState } from 'react';
import type { AdminTariffEvent, AdminTariffRow, AdminTariffSeat } from '@video-compressor/shared';
import type { AdminTariffClient } from '../../api/team';
import { useToasts } from '../../components/toast';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  LoadingState,
  Timeline,
  User
} from '../../components/ui/index';
import { useI18n, type Language, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../../team/errors';
import { formatTariffDay, formatTariffMoment, pluralForm } from '../../team/tariffs/format';
import { eventField, eventNumber, newestFirst } from './tariffModel';

/**
 * One tariff's story and who sits in its seats (034, US3.5–3.6).
 *
 * The history is written as sentences a person says — «Роман продовжив до
 * 12.12 (було 12.11)», «Додав 1 місце» — not as a diff of columns. The seats
 * list is where seats are freed when the plan has to shrink: a member taken
 * off the space, an invitation revoked. The owner cannot be taken off.
 */

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function describe(
  event: AdminTariffEvent,
  t: Translate,
  day: (value: string | null) => string,
  language: Language
): string {
  const actor = event.actorName ?? t('adminTariffActorSystem');
  const before = event.before;
  const after = event.after;
  switch (event.kind) {
    case 'granted':
      return t('adminTariffEventGranted', {
        actor,
        plan: eventField(after, 'planNameUk') ?? eventField(after, 'planCode') ?? '',
        date: day(eventField(after, 'endsOn'))
      });
    case 'extended':
      return t('adminTariffEventExtended', {
        actor,
        date: day(eventField(after, 'endsOn')),
        was: day(eventField(before, 'endsOn'))
      });
    case 'updated': {
      const parts: string[] = [];
      const fromDay = eventField(before, 'endsOn');
      const toDay = eventField(after, 'endsOn');
      if (toDay && toDay !== fromDay) {
        parts.push(t('adminTariffEventDate', { actor, date: day(toDay), was: day(fromDay) }));
      }
      const fromPlan = eventField(before, 'planCode');
      const toPlan = eventField(after, 'planCode');
      if (toPlan && toPlan !== fromPlan) {
        parts.push(
          t('adminTariffEventPlan', {
            actor,
            plan: eventField(after, 'planNameUk') ?? toPlan
          })
        );
      }
      const fromSeats = eventNumber(before, 'extraSeats');
      const toSeats = eventNumber(after, 'extraSeats');
      if (fromSeats !== null && toSeats !== null && toSeats !== fromSeats) {
        const count = Math.abs(toSeats - fromSeats);
        parts.push(
          t(
            toSeats > fromSeats
              ? pluralForm(language, count, {
                  one: 'adminTariffEventSeatsAddedOne',
                  few: 'adminTariffEventSeatsAddedFew',
                  many: 'adminTariffEventSeatsAddedMany'
                })
              : pluralForm(language, count, {
                  one: 'adminTariffEventSeatsRemovedOne',
                  few: 'adminTariffEventSeatsRemovedFew',
                  many: 'adminTariffEventSeatsRemovedMany'
                }),
            { actor, count }
          )
        );
      }
      if (after && 'note' in after && eventField(after, 'note') !== eventField(before, 'note')) {
        parts.push(t('adminTariffEventNote', { actor }));
      }
      return parts.length ? parts.join(' · ') : t('adminTariffEventUpdated', { actor });
    }
    case 'ended_today':
      return t('adminTariffEventEndedToday', { actor });
    case 'ended_now':
      return t('adminTariffEventEndedNow', { actor });
    case 'undone':
      return t('adminTariffEventUndone', { actor });
    case 'member_removed':
      return t('adminTariffEventMemberRemoved', {
        actor,
        who: eventField(after, 'email') ?? eventField(after, 'name') ?? ''
      });
    case 'invitation_revoked':
      return t('adminTariffEventInvitationRevoked', {
        actor,
        who: eventField(after, 'email') ?? ''
      });
    case 'bound':
      return t('adminTariffEventBound', { space: eventField(after, 'teamName') ?? '' });
    case 'claimed':
      return t('adminTariffEventClaimed');
    case 'owner_deleted':
      return t('adminTariffEventOwnerDeleted');
    case 'settings':
      return t('adminTariffEventSettings', { actor });
  }
}

const TONE: Partial<Record<AdminTariffEvent['kind'], 'success' | 'warning' | 'error'>> = {
  granted: 'success',
  extended: 'success',
  ended_today: 'warning',
  ended_now: 'error',
  owner_deleted: 'error',
  member_removed: 'warning'
};

export function TariffHistoryDrawer({
  row,
  client,
  onClose,
  onChanged
}: {
  row: AdminTariffRow;
  client: AdminTariffClient;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const [events, setEvents] = useState<AdminTariffEvent[] | null>(null);
  const [seats, setSeats] = useState<AdminTariffSeat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<AdminTariffSeat | null>(null);
  const [busy, setBusy] = useState(false);
  const day = (value: string | null) => (value ? formatTariffDay(value, language) : '—');

  const load = useCallback(() => {
    setFailed(false);
    void client.listEvents(row.id).then(
      value => setEvents(newestFirst(value)),
      () => setFailed(true)
    );
    if (row.teamId) {
      void client.listSeats(row.teamId).then(setSeats, () => setSeats([]));
    } else {
      setSeats([]);
    }
  }, [client, row.id, row.teamId]);

  useEffect(load, [load]);

  const free = async (seat: AdminTariffSeat) => {
    if (!row.teamId) return;
    setBusy(true);
    try {
      if (seat.kind === 'invitation' && seat.invitationId) {
        await client.revokeInvitation(seat.invitationId);
        push({ tone: 'success', text: t('teamToastInvitationRevoked') });
      } else if (seat.userId) {
        await client.removeMember(row.teamId, seat.userId);
        push({ tone: 'success', text: t('adminTariffMemberRemoved') });
      }
      setConfirm(null);
      load();
      onChanged();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      side="right"
      size="lg"
      onClose={onClose}
      title={row.teamName ? `${row.ownerEmail} · ${row.teamName}` : row.ownerEmail}
      footer={
        <Button color="neutral" variant="outline" onClick={onClose}>
          {t('teamClose')}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {row.teamId && (
          <section className="flex flex-col gap-2" aria-labelledby="admin-tariff-seats">
            <h3 id="admin-tariff-seats" className="admin-tariff-subtitle">
              {t('adminTariffSeatsTitle', { used: row.seatsUsed, total: row.seatsTotal })}
            </h3>
            {seats === null ? (
              <LoadingState shape="row" count={3} label={t('loading')} />
            ) : seats.length === 0 ? (
              <EmptyState size="sm" title={t('adminTariffSeatsEmpty')} />
            ) : (
              <ul className="admin-tariff-seats">
                {seats.map(seat => (
                  <li key={seat.userId ?? seat.invitationId} className="admin-tariff-seat">
                    <User
                      name={seat.name ?? seat.email ?? '—'}
                      meta={
                        seat.kind === 'invitation'
                          ? t('adminTariffSeatInvitation', { email: seat.email ?? '' })
                          : (seat.email ?? undefined)
                      }
                    />
                    <span className="flex items-center gap-2">
                      {seat.isOwner && <Badge size="xs">{t('teamRoleOwner')}</Badge>}
                      {seat.isAdmin && (
                        <Badge size="xs" color="info">
                          {t('adminTariffSeatAdmin')}
                        </Badge>
                      )}
                      {!seat.isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          color="error"
                          onClick={() => setConfirm(seat)}
                        >
                          {seat.kind === 'invitation'
                            ? t('teamInvitationRevoke')
                            : t('adminTariffRemoveMember')}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2" aria-labelledby="admin-tariff-history">
          <h3 id="admin-tariff-history" className="admin-tariff-subtitle">
            {t('adminTariffHistory')}
          </h3>
          {failed ? (
            <ErrorState message={t('adminError')} onRetry={load} retryLabel={t('retry')} />
          ) : events === null ? (
            <LoadingState shape="row" count={4} label={t('loading')} />
          ) : events.length === 0 ? (
            <EmptyState size="sm" title={t('adminTariffHistoryEmpty')} />
          ) : (
            <Timeline
              entries={events.map(event => ({
                id: event.id,
                title: describe(event, t, day, language),
                meta: formatTariffMoment(event.createdAt, language),
                tone: TONE[event.kind] ?? 'neutral'
              }))}
            />
          )}
        </section>
      </div>
      {confirm && (
        <ConfirmDialog
          nested
          title={
            confirm.kind === 'invitation'
              ? t('teamInvitationRevokeConfirmTitle', { email: confirm.email ?? '' })
              : t('adminTariffRemoveTitle', { who: confirm.name ?? confirm.email ?? '' })
          }
          body={
            confirm.kind === 'invitation'
              ? t('teamInvitationRevokeConfirmBody')
              : t('adminTariffRemoveBody')
          }
          confirmLabel={
            confirm.kind === 'invitation' ? t('teamInvitationRevoke') : t('adminTariffRemoveMember')
          }
          cancelLabel={t('teamCancel')}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void free(confirm)}
        />
      )}
    </Drawer>
  );
}
