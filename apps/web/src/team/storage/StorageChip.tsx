import { useId, useRef, useState } from 'react';
import type { StorageHealth, TeamStorageAttentionReason } from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { useOptionalBackgroundRender } from '../explorer/BackgroundRenderProvider';
import type { DriveRootResult } from '../../api/team';
import { rememberDriveAuthorization } from '../drive/authorizationReturn';
import { WorkspaceChip, type ChipTone } from '../workspace/WorkspaceChip';
import { Button, PermissionState, uiClasses } from '../../components/ui/index';

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

export function chipCopy(
  health: StorageHealth,
  t: ReturnType<typeof useI18n>['t'],
  /* Previews held on this computer (024): the chip said "preparing previews" while the person
     had just pressed pause, so the one control in the panel looked like it did nothing. */
  renderPaused?: boolean
): string {
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
      if (renderPaused) return t('teamStorageChipRenderPaused');
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
  onRefresh,
  open: openProp,
  onOpenChange
}: {
  teamId: string;
  health: StorageHealth | null;
  client: StorageChipClient;
  isOwner: boolean;
  canManage: boolean;
  /** Where the full storage panel lives (the settings dialog's address). */
  settingsHref: string;
  onRefresh?: () => Promise<void> | void;
  /**
   * The detail, held by the caller when it is in the address (024, FR-050):
   * "the Drive needs reconnecting — look" is a link worth sending, and a reload
   * in the middle of reading it should not close it. Uncontrolled without.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const render = useOptionalBackgroundRender();
  const [localOpen, setLocalOpen] = useState(false);
  const open = openProp ?? localOpen;
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setLocalOpen(next));
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const titleId = useId();
  /*
   * How long the indexing has been going (024).
   *
   * The chip counted files and folders and nothing else, so a walk through a large Drive read as
   * a spinner with no end — the owner asked, fairly, whether it would spin forever. The count of
   * minutes is the one thing that says it is a job with a length.
   */
  const indexingSince = useRef<number | null>(null);
  if (health?.kind === 'indexing') indexingSince.current ??= Date.now();
  else indexingSince.current = null;
  const indexingMinutes =
    indexingSince.current === null ? 0 : Math.floor((Date.now() - indexingSince.current) / 60_000);
  if (!health) return null;

  /* The chip's colour is the state's role, so storage needing attention is the
     same amber as anything else that needs attention (021, T084). */
  const tone: ChipTone =
    health.kind === 'attention'
      ? 'warn'
      : health.kind === 'indexing' ||
          health.kind === 'preparing' ||
          health.kind === 'waiting_provider'
        ? 'busy'
        : 'ok';
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
      // Google's redirect cannot say which space this was for, so the press
      // says it: the return reads this instead of guessing (authorizationReturn).
      rememberDriveAuthorization(teamId, 'space');
      const started = await client.startDriveOAuth(teamId);
      setAuthorizationUrl(started.authorizationUrl);
      // Go where the press was aimed. Asking Google for the address used to
      // leave the person looking at a second, differently-worded button they
      // had to find and press before anything happened — a toll rather than a
      // step. `location.assign` is not gated on user activation (unlike
      // `window.open`, which is what popup blockers are for), so an address
      // that arrives after an await is still free to navigate. The address
      // stays in state as well: a browser that refuses to leave the page must
      // leave a link behind rather than a dead end.
      location.assign(started.authorizationUrl);
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
      {/* Healthy storage is the default and says nothing (024, FR-094): "storage
          up to date · 64 hours ago" was the header's permanent first word. The
          chip speaks when there is something to know; the detail stays one
          address away (`storage=1`) and in the settings. */}
      {health.kind !== 'connected' && (
        <WorkspaceChip
          tone={tone}
          busy={busyState}
          className="team-storage-chip"
          label={chipCopy(health, t, render?.paused)}
          opensDialog
          onPress={() => setOpen(true)}
        >
          {chipCopy(health, t, render?.paused)}
        </WorkspaceChip>
      )}
      {open && (
        <Modal
          labelledBy={titleId}
          size="sm"
          onClose={() => setOpen(false)}
          closeLabel={t('teamClose')}
        >
          <h3 id={titleId}>{t('teamStorageDetailTitle')}</h3>
          <p className="team-storage-detail-state">{chipCopy(health, t, render?.paused)}</p>
          {health.kind === 'attention' && <p>{t(ATTENTION_BODY[health.reason])}</p>}
          {health.kind === 'waiting_provider' && <p>{t('teamStorageBodyWaiting')}</p>}
          {health.kind === 'indexing' && (
            <>
              <p>{t('teamStorageBodyIndexing')}</p>
              {/* Where it runs and how long it has run: the panel's own buttons cannot stop it,
                  and a reader owed that before they start looking for a way to. */}
              <p className="team-storage-detail-note">
                {indexingMinutes > 0
                  ? t('teamStorageIndexingElapsed', { count: indexingMinutes })
                  : t('teamStorageIndexingServerSide')}
              </p>
              {/* The question the spinner raises (024): a first read cannot be stopped halfway —
                  the folders it never reached would sit in the space looking empty. The way out
                  exists and is named rather than hidden. */}
              <p className="team-storage-detail-note">{t('teamStorageIndexingCannotStop')}</p>
            </>
          )}
          {health.kind === 'preparing' && (
            <p>{t(render?.paused ? 'teamStorageBodyRenderPaused' : 'teamStorageBodyPreparing')}</p>
          )}
          {/* Not a failure — a boundary. Whoever is reading this cannot fix
              the storage, and saying so in red reads as something they did
              wrong (FR-004). */}
          {fixerCopy && <PermissionState message={fixerCopy} />}
          <div className="team-dialog-actions">
            {health.kind === 'attention' &&
              health.reason === 'needs_reauth' &&
              isOwner &&
              !authorizationUrl &&
              client.startDriveOAuth && (
                <Button
                  color="primary"
                  variant="solid"
                  loading={busy}
                  onClick={() => void reconnect()}
                >
                  {t('teamStorageReconnect')}
                </Button>
              )}
            {authorizationUrl && (
              <a
                className={uiClasses('button', { color: 'primary', variant: 'solid', size: 'md' })}
                href={authorizationUrl}
                rel="noreferrer"
              >
                {t('teamDriveAuthorize')}
              </a>
            )}
            {health.kind === 'attention' &&
              health.reason === 'root_missing' &&
              isOwner &&
              client.restoreRoot && (
                <Button
                  color="primary"
                  variant="solid"
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
                  color="neutral"
                  variant="outline"
                  loading={busy}
                  onClick={() =>
                    void run(() => client.resyncDrive!(teamId), 'teamToastResyncQueued')
                  }
                >
                  {t('teamStorageCheckNow')}
                </Button>
              )}
            {/* Quiet: this one changes how this computer behaves, and it was
                the only bordered control in a panel that is otherwise a
                report — the loudest thing on screen was the one thing nobody
                opened the panel to do. */}
            {render?.available && (
              <Button
                color="neutral"
                variant="ghost"
                onClick={() => render.setPaused(!render.paused)}
              >
                {render.paused ? t('teamStorageResumeRender') : t('teamStoragePauseRender')}
              </Button>
            )}
            {isOwner && (
              <a
                className={uiClasses('button', { color: 'neutral', variant: 'ghost', size: 'md' })}
                href={settingsHref}
                onClick={event => {
                  setOpen(false);
                  internalLink(event, settingsHref);
                }}
              >
                {t('teamStorageOpenSettings')}
              </a>
            )}
            {/*
             * "Close", not "Cancel". Nothing here is a change waiting to be
             * confirmed — the indexing runs on the server whatever this panel
             * does — and "Cancel" beside a progress line reads as "stop the
             * indexing", which is the one thing it must not be mistaken for.
             * It is also the calm default, so it is the bordered one.
             */}
            <Button color="neutral" variant="outline" onClick={() => setOpen(false)}>
              {t('teamClose')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
