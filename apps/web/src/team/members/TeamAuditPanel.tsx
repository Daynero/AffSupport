import { useEffect, useState } from 'react';
import type { TeamAuditEventSummary } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';

/**
 * The history is for people, so it says what happened rather than printing the
 * identifier the database stores. An action with no entry here still renders —
 * its raw name is better than a blank row — but every action this application
 * writes has one.
 */
const ACTION_LABEL: Readonly<Record<string, TranslationKey>> = {
  'drive.connected': 'teamAuditDriveConnected',
  'drive.detached': 'teamAuditDriveDetached',
  'drive.resynced': 'teamAuditDriveResynced',
  'invitation.accepted': 'teamAuditInvitationAccepted',
  'invitation.created': 'teamAuditInvitationCreated',
  'invitation.declined': 'teamAuditInvitationDeclined',
  'invitation.resent': 'teamAuditInvitationResent',
  'invitation.revoked': 'teamAuditInvitationRevoked',
  // Two writers name these: the older events carry a past-tense word, while a
  // finished transfer operation is recorded as `material.` plus its own kind
  // ('rename', 'move', …). Both spellings are on the wire, so both are here —
  // an unmapped action fell through to the raw key, and "material.rename" in
  // the history of a space is a leak of the schema, not a sentence.
  'material.content_edit': 'teamAuditMaterialEdited',
  'material.content_edited': 'teamAuditMaterialEdited',
  'material.download': 'teamAuditMaterialDownloaded',
  'material.metadata_updated': 'teamAuditMaterialMetadata',
  'material.move': 'teamAuditMaterialMoved',
  'material.new_version': 'teamAuditMaterialVersion',
  'material.process': 'teamAuditMaterialProcessed',
  'material.processed': 'teamAuditMaterialProcessed',
  'material.rename': 'teamAuditMaterialRenamed',
  'material.restore': 'teamAuditMaterialRestored',
  'material.trash': 'teamAuditMaterialTrashed',
  'material.upload': 'teamAuditMaterialUploaded',
  'material.uploaded': 'teamAuditMaterialUploaded',
  'material.version_created': 'teamAuditMaterialVersion',
  'storage.selection_added': 'teamAuditStorageFolderAdded',
  'storage.selection_removed': 'teamAuditStorageFolderRemoved',
  'membership.direct_added': 'teamAuditMemberAdded',
  'membership.left': 'teamAuditMemberLeft',
  'membership.removed': 'teamAuditMemberRemoved',
  'membership.updated': 'teamAuditMemberUpdated',
  'task.deleted': 'teamAuditTaskDeleted',
  'team.created': 'teamAuditTeamCreated',
  'team.draft_deleted': 'teamAuditTeamDraftDeleted'
};

/** Sync states and roles reach the panel as their stored words. */
const DETAIL_LABEL: Readonly<Record<string, TranslationKey>> = {
  scanning: 'teamSyncProgressScanningShort',
  replaying: 'teamSyncProgressReplayingShort',
  connected: 'teamDriveConnected',
  ready: 'teamAuditDetailReady',
  failed: 'teamAuditDetailFailed',
  owner: 'teamRoleOwner',
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
};

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, revision, t, teamId]);

  return (
    <section className="team-panel team-audit-panel" aria-labelledby="team-audit-title">
      <h2 id="team-audit-title">{t('teamAuditTitle')}</h2>
      {error && <p className="team-inline-error">{error}</p>}
      {/* Loading and empty are different answers: the panel used to give the
          second one while it was still waiting for the first (finding S9). */}
      {loading && !error && <LabeledSkeleton label="teamAuditLoading" rows={3} />}
      {!loading && !error && events.length === 0 && <p>{t('teamAuditEmpty')}</p>}
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
                <strong>
                  {ACTION_LABEL[event.action] ? t(ACTION_LABEL[event.action]!) : event.action}
                </strong>
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
              {safeDetail && (
                <small>
                  {DETAIL_LABEL[safeDetail] ? t(DETAIL_LABEL[safeDetail]!) : safeDetail}
                </small>
              )}
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
