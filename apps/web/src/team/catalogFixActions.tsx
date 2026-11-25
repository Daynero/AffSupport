import { useState } from 'react';
import { useOptionalAgent } from '../AgentContext';
import { disableBackgroundRecovery } from '../api/recovery';
import { ReconnectAction } from '../components/ReconnectAction';
import { Button, uiClasses } from '../components/ui/index';
import { useI18n, type TranslationKey, type Translate } from '../i18n';
import { internalLink } from '../lib/navigation';
import { teamErrorMessage, teamErrorMessageFor } from './errors';
import { spaceRouteFor } from './SpaceSettingsLink';
import type { TeamSettingsTab } from './routes';
import { useOptionalTeam } from './TeamContext';

/**
 * Where a catalog that cannot go on is fixed (072).
 *
 * The audit of 2026-11-25 found the same shape everywhere: a creation, a publication or a manager
 * round stopped on a code the person could do something about, and the page said a sentence —
 * sometimes the wrong one — with nothing to press. One code is one sentence (`catalogCodeMessage`)
 * and one door (`CatalogFixButton`), in this one module, so the creation dialog, the publication
 * dialog and the catalog manager (П5) cannot drift into three different answers.
 */
export type CatalogFixAction =
  /** Soty on this computer is not reachable from the page: the one «Reconnect». */
  | 'connect_agent'
  /** Background work exists but does not take the work: set it up again. */
  | 'repair_background'
  /** The computer's Soty is too old for the work. */
  | 'update_agent'
  /** The space's Drive connection is gone: the owner reconnects it in the settings. */
  | 'drive'
  /** The space is paused: the owner's tariff, in the settings. */
  | 'tariffs'
  /** The re-stitch settings are missing or refused. */
  | 'restitch'
  /** The Google account behind the space's Drive is full: its storage page. */
  | 'google_storage'
  /** Passing trouble (Drive slow, rate limit, an unconfirmed answer): the caller's own retry. */
  | 'retry'
  /** The catalog's source moved under it: open the catalog. */
  | 'open_catalog';

const ACTION_BY_CODE: Readonly<Record<string, CatalogFixAction>> = {
  AGENT_REQUIRED: 'connect_agent',
  AGENT_STALLED: 'repair_background',
  AGENT_ID_CONFLICT: 'repair_background',
  AGENT_UPDATE_REQUIRED: 'update_agent',
  RESTITCH_CLIENT_OUTDATED: 'update_agent',
  NEEDS_REAUTH: 'drive',
  DRIVE_NOT_CONNECTED: 'drive',
  ROOT_MISSING: 'drive',
  DRIVE_STORAGE_FULL: 'google_storage',
  DRIVE_UNAVAILABLE: 'retry',
  RATE_LIMITED: 'retry',
  PROCESS_RESULT_UNCERTAIN: 'retry',
  SOURCE_CHANGED: 'open_catalog',
  // CONNECTION_DETACHED (the catalog stays in the space's previous folder), DISK_FULL (free space
  // on the computer), PERMISSION_DENIED and SHARE_NOT_ALLOWED have no door: the sentence is all.
  SPACE_BLOCKED: 'tariffs',
  RESTITCH_INVALID: 'restitch',
  RESTITCH_DEFAULTS_INVALID: 'restitch',
  RESTITCH_NO_SCREENS: 'restitch',
  RESTITCH_POOL_EMPTY: 'restitch',
  RESTITCH_SOURCES_INVALID: 'restitch',
  RESTITCH_SOURCE_FORBIDDEN: 'restitch',
  RESTITCH_SOURCES_TOO_MANY: 'restitch'
};

/** The door for a code, or `null` when there is nothing for the person to do but wait or retry. */
export function catalogFixActionFor(code: string | null | undefined): CatalogFixAction | null {
  return code ? (ACTION_BY_CODE[code] ?? null) : null;
}

/**
 * Catalog readings of codes whose general sentence says something else here: AGENT_REQUIRED in
 * general is «Soty is not running on this computer», but a catalog's videos wait for *any*
 * computer with background work; AGENT_ID_CONFLICT in general is an account's agent ID.
 */
const CATALOG_COPY: Readonly<Record<string, TranslationKey>> = {
  AGENT_REQUIRED: 'catalogWaitAgentRequired',
  AGENT_ID_CONFLICT: 'catalogWaitAgentIdConflict',
  AGENT_STALLED: 'catalogWaitAgentStalled',
  AGENT_UPDATE_REQUIRED: 'catalogWaitAgentUpdateRequired',
  NEEDS_REAUTH: 'catalogWaitNeedsReauth',
  SPACE_BLOCKED: 'catalogWaitSpaceBlocked'
};

/** Where a full Google storage is cleaned up; it is the owner's Google account. */
export const GOOGLE_STORAGE_URL = 'https://drive.google.com/settings/storage';

/** One sentence for a catalog's wait reason or failure code; unknown codes get the general one. */
export function catalogCodeMessage(code: string | null | undefined, t: Translate): string {
  const key = code ? CATALOG_COPY[code] : undefined;
  return key ? t(key) : teamErrorMessage(code, t);
}

function SettingsDoor({
  teamId,
  tab,
  label
}: {
  teamId: string;
  tab: TeamSettingsTab;
  label: string;
}) {
  const href = spaceRouteFor(teamId, { kind: 'settings', tab });
  return (
    <a
      className={uiClasses('button', { color: 'neutral', variant: 'outline', size: 'sm' })}
      href={href}
      onClick={event => internalLink(event, href)}
    >
      {label}
    </a>
  );
}

function RepairBackground({ teamId, onRepaired }: { teamId: string; onRepaired?: () => void }) {
  const { t } = useI18n();
  const [repairing, setRepairing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const repair = async () => {
    setRepairing(true);
    setFailure(null);
    try {
      // Withdraws the background credential on both sides; the page's own setup loop hears the
      // change and sets up a new one (CatalogBackgroundStalledNote, BackgroundRecoveryNotice).
      await disableBackgroundRecovery(teamId);
      onRepaired?.();
    } catch (error) {
      setFailure(
        teamErrorMessageFor(
          error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.message)
            ? { code: error.message }
            : error,
          t
        )
      );
    } finally {
      setRepairing(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" disabled={repairing} onClick={() => void repair()}>
        {t(repairing ? 'backgroundRecoveryRepairing' : 'backgroundRecoveryRepair')}
      </Button>
      {failure && (
        <span role="alert" className="team-inline-error">
          {failure}
        </span>
      )}
    </>
  );
}

/**
 * The button beside a catalog's stopped state. Renders nothing when the code has no door, and
 * says «the owner can fix this» where only the owner can (Drive, tariff).
 */
export function CatalogFixButton({
  teamId,
  code,
  onRepaired,
  onRetry,
  catalogUrl
}: {
  teamId: string;
  code: string | null | undefined;
  /** Background work was set up again; the caller reads its state anew. */
  onRepaired?: () => void;
  /** The caller's own «try again» for passing trouble; without it there is no button. */
  onRetry?: () => void;
  /** The catalog's sheet, for a source that changed under it; without it there is no button. */
  catalogUrl?: string;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const space = useOptionalTeam();
  const action = catalogFixActionFor(code);
  if (!action) return null;
  const owner =
    space?.teams.find(team => team.id === teamId)?.role === 'owner' ||
    (space?.activeTeam?.id === teamId && space.activeTeam.role === 'owner');
  if (action === 'retry')
    return onRetry ? (
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('tryAgain')}
      </Button>
    ) : null;
  if (action === 'open_catalog')
    return catalogUrl ? (
      <a
        className={uiClasses('button', { color: 'neutral', variant: 'outline', size: 'sm' })}
        href={catalogUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('catalogFixOpenCatalog')}
      </a>
    ) : null;
  if (action === 'drive' || action === 'tariffs')
    return owner ? (
      <SettingsDoor
        teamId={teamId}
        tab="general"
        label={t(
          action === 'tariffs'
            ? 'catalogFixOpenTariff'
            : code === 'ROOT_MISSING'
              ? 'catalogFixChooseDriveFolder'
              : 'catalogFixReconnectDrive'
        )}
      />
    ) : (
      <span className="field-hint">{t('catalogFixAskOwner')}</span>
    );
  if (action === 'google_storage')
    return owner ? (
      <a
        className={uiClasses('button', { color: 'neutral', variant: 'outline', size: 'sm' })}
        href={GOOGLE_STORAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('catalogFixOpenGoogleStorage')}
      </a>
    ) : (
      <span className="field-hint">{t('catalogFixAskOwner')}</span>
    );
  if (action === 'restitch')
    return (
      <SettingsDoor teamId={teamId} tab="restitch" label={t('launchesOpenRestitchSettings')} />
    );
  // Everything about the computer starts from reaching Soty on it.
  if (agent?.connection !== 'connected' || action === 'update_agent')
    return <ReconnectAction surface="team_actions" size="sm" />;
  // Reached, and the work still is not taken: set background work up again — only an agent
  // that reports a lost handle cleanly can be repaired from here without parking the space.
  if (agent.capabilities?.includes('team-background-recovery-lost-handle'))
    return <RepairBackground teamId={teamId} onRepaired={onRepaired} />;
  return null;
}
