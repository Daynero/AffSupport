import { useId, useState } from 'react';
import type { StorageHealth, TeamStorageAttentionReason } from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { useOptionalBackgroundRender } from '../explorer/BackgroundRenderProvider';
import type { DriveRootResult } from '../../api/team';

/**
 * One chip, one state, on every team screen (011, FR-031). Click for the
 * detail: what is happening, who can fix it, and the one action that does.
 */
export interface StorageChipClient {
  resyncDrive?: (teamId: string) => Promise<unknown>;
  startDriveOAuth?: (teamId: string) => Promise<{ authorizationUrl: string; expiresAt: string }>;
  restoreRoot?: (teamId: string) => Promise<DriveRootResult>;
}

const ATTENTION_CHIP: Record<TeamStorageAttentionReason, TranslationKey> = {
  needs_reauth: 'teamStorageChipNeedsReauth',
  root_missing: 'teamStorageChipRootMissing',
  permission_lost: 'teamStorageChipPermissionLost',
  quota: 'teamStorageChipQuota',
  sync_failed: 'teamStorageChipSyncFailed'
};

const ATTENTION_BODY: Record<TeamStorageAttentionReason, TranslationKey> = {
  needs_reauth: 'teamStorageBodyNeedsReauth',
  root_missing: 'teamStorageBodyRootMissing',
  permission_lost: 'teamStorageBodyPermissionLost',
  quota: 'teamStorageBodyQuota',
  sync_failed: 'teamStorageBodySyncFailed'
};

function ago(iso: string, t: ReturnType<typeof useI18n>['t']): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 1) return t('teamStorageJustNow');
  if (minutes < 60) return t('teamStorageMinutesAgo', { count: minutes });
  return t('teamStorageHoursAgo', { count: Math.round(minutes / 60) });
}

export function chipCopy(health: StorageHealth, t: ReturnType<typeof useI18n>['t']): string {
  switch (health.kind) {
    case 'connected':
      return t('teamStorageChipConnected', { ago: ago(health.lastReconciledAt, t) });
    case 'indexing':
      return health.totalFolders === null
        ? t('teamStorageChipIndexingOpen', {
            files: health.files,
            folders: Math.max(0, health.indexedFolders)
          })
        : t('teamStorageChipIndexing', {
            done: health.indexedFolders,
            total: health.totalFolders,
            files: health.files
          });
    case 'preparing':
      return t('teamStorageChipPreparing', {
        ready: health.ready,
        total: health.ready + health.pending
      });
    case 'waiting_provider':
      return t('teamStorageChipWaiting');
    case 'attention':
      return t(ATTENTION_CHIP[health.reason]);
    case 'disconnected':
      return t('teamStorageChipDisconnected');
  }
}

export function StorageChip({
  teamId,
  health,
  client,
  isOwner,
  canManage,
  settingsHref,
  onRefresh
}: {
  teamId: string;
  health: StorageHealth | null;
  client: StorageChipClient;
  isOwner: boolean;
  canManage: boolean;
  /** Where the full storage panel lives (the settings dialog's address). */
  settingsHref: string;
  onRefresh?: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const render = useOptionalBackgroundRender();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const titleId = useId();
  if (!health) return null;

  const tone =
    health.kind === 'attention'
      ? 'ui-chip-warn'
      : health.kind === 'indexing' ||
          health.kind === 'preparing' ||
          health.kind === 'waiting_provider'
        ? 'ui-chip-busy'
        : '';
  const busyState =
    health.kind === 'indexing' || health.kind === 'preparing' || health.kind === 'waiting_provider';

  const run = async (action: () => Promise<unknown>, done: TranslationKey) => {
    setBusy(true);
    try {
      await action();
      push({ tone: 'success', text: t(done) });
      await onRefresh?.();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!client.startDriveOAuth) return;
    setBusy(true);
    try {
      const started = await client.startDriveOAuth(teamId);
      setAuthorizationUrl(started.authorizationUrl);
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const fixerCopy =
    health.kind === 'attention'
      ? health.fixer === 'owner'
        ? isOwner
          ? null
          : t('teamStorageFixerOwner')
        : canManage
          ? null
          : t('teamStorageFixerManager')
      : null;

  return (
    <>
      <button
        type="button"
        className={`ui-chip team-storage-chip ${tone}`}
        aria-live="polite"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {busyState && <span className="ui-chip-spinner" aria-hidden="true" />}
        {chipCopy(health, t)}
      </button>
      {open && (
        <Modal labelledBy={titleId} size="sm" onClose={() => setOpen(false)}>
          <h3 id={titleId}>{t('teamStorageDetailTitle')}</h3>
          <p className="team-storage-detail-state">{chipCopy(health, t)}</p>
          {health.kind === 'attention' && <p>{t(ATTENTION_BODY[health.reason])}</p>}
          {health.kind === 'waiting_provider' && <p>{t('teamStorageBodyWaiting')}</p>}
          {health.kind === 'indexing' && <p>{t('teamStorageBodyIndexing')}</p>}
          {health.kind === 'preparing' && <p>{t('teamStorageBodyPreparing')}</p>}
          {fixerCopy && <p className="team-inline-error">{fixerCopy}</p>}
          <div className="team-dialog-actions">
            {health.kind === 'attention' &&
              health.reason === 'needs_reauth' &&
              isOwner &&
              !authorizationUrl &&
              client.startDriveOAuth && (
                <Button
                  type="button"
                  variant="primary"
                  loading={busy}
                  onClick={() => void reconnect()}
                >
                  {t('teamStorageReconnect')}
                </Button>
              )}
            {authorizationUrl && (
              <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
                {t('teamDriveAuthorize')}
              </a>
            )}
            {health.kind === 'attention' &&
              health.reason === 'root_missing' &&
              isOwner &&
              client.restoreRoot && (
                <Button
                  type="button"
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    void run(() => client.restoreRoot!(teamId), 'teamDriveRootRestored')
                  }
                >
                  {t('teamDriveRestoreRoot')}
                </Button>
              )}
            {(health.kind === 'connected' ||
              health.kind === 'preparing' ||
              (health.kind === 'attention' && health.reason === 'sync_failed')) &&
              canManage &&
              client.resyncDrive && (
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy}
                  onClick={() =>
                    void run(() => client.resyncDrive!(teamId), 'teamToastResyncQueued')
                  }
                >
                  {t('teamStorageCheckNow')}
                </Button>
              )}
            {render?.available && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => render.setPaused(!render.paused)}
              >
                {render.paused ? t('teamStorageResumeRender') : t('teamStoragePauseRender')}
              </Button>
            )}
            {isOwner && (
              <a
                className="button button-ghost"
                href={settingsHref}
                onClick={event => {
                  setOpen(false);
                  internalLink(event, settingsHref);
                }}
              >
                {t('teamStorageOpenSettings')}
              </a>
            )}
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
