import { useEffect, useState } from 'react';
import type { TeamAuditEventSummary } from '../../api/team';
import { useI18n } from '../../i18n';

export interface TeamAuditClient {
  listAuditEvents: (
    teamId: string,
    options?: { limit?: number; before?: string }
  ) => Promise<TeamAuditEventSummary[]>;
}

export function TeamAuditPanel({
  teamId,
  client,
  revision = 0
}: {
  teamId: string;
  client: TeamAuditClient;
  revision?: number;
}) {
  const { t, language } = useI18n();
  const [events, setEvents] = useState<TeamAuditEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listAuditEvents(teamId, { limit: 50 })
      .then(value => {
        if (active) {
          setEvents(value);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError(t('teamAuditLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [client, revision, t, teamId]);

  return (
    <section className="team-panel team-audit-panel" aria-labelledby="team-audit-title">
      <h2 id="team-audit-title">{t('teamAuditTitle')}</h2>
      {error && <p className="team-inline-error">{error}</p>}
      {!error && events.length === 0 && <p>{t('teamAuditEmpty')}</p>}
      <ol className="team-audit-list">
        {events.map(event => {
          const safeDetail =
            event.target.role ??
            event.target.state ??
            event.target.relation ??
            event.target.warning_code;
          return (
            <li key={event.id}>
              <div>
                <strong>{event.action}</strong>
                <span>{event.actorLabel ?? t('teamFormerMember')}</span>
              </div>
              <span className={`team-audit-result is-${event.result}`}>
                {t(
                  event.result === 'succeeded'
                    ? 'teamAuditSucceeded'
                    : event.result === 'denied'
                      ? 'teamAuditDenied'
                      : event.result === 'canceled'
                        ? 'teamAuditCanceled'
                        : 'teamAuditFailed'
                )}
              </span>
              {safeDetail && <small>{safeDetail}</small>}
              {event.errorCode && <code>{event.errorCode}</code>}
              <time dateTime={event.occurredAt}>
                {new Intl.DateTimeFormat(language, {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                }).format(new Date(event.occurredAt))}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
