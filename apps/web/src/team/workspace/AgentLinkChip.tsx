import { useOptionalAgent } from '../../AgentContext';
import { agentLocalUrl } from '../../api/client';
import { ReconnectAction } from '../../components/ReconnectAction';
import { useI18n } from '../../i18n';
import { WorkspaceChip } from './WorkspaceChip';

/**
 * The space's chip for the local app (032, FR-010/FR-013).
 *
 * The workspace had no word for the agent at all: a dropped link showed up only
 * as greyed-out actions, each with its own guess at why (research W11). One chip
 * says which of the reasons it is, and carries the action that fits — reconnect
 * for a lost link, the update for an old agent, the Agent's own copy of the page
 * for a browser that blocks loopback. Nothing while the link is fine, and
 * nothing while the first check is still running: a chip that flashes
 * "connect Soty" on every page load is noise.
 */
export function AgentLinkChip() {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  if (!agent) return null;
  const { connection, teamWorkspaceAvailability } = agent;
  if (connection === 'checking' || connection === 'connecting') return null;
  if (teamWorkspaceAvailability === 'ready') return null;
  if (teamWorkspaceAvailability === 'too_old') {
    return (
      <WorkspaceChip tone="warn" label={t('localAppUpdateTitle')} className="team-agent-link-chip">
        {t('localAppUpdateTitle')}
      </WorkspaceChip>
    );
  }
  if (teamWorkspaceAvailability === 'blocked') {
    return (
      <WorkspaceChip
        tone="warn"
        label={t('linkOpenInSoty')}
        href={agentLocalUrl()}
        className="team-agent-link-chip"
      >
        {t('linkBrowserBlocked')}
      </WorkspaceChip>
    );
  }
  if (teamWorkspaceAvailability === 'account') {
    return (
      <WorkspaceChip tone="warn" label={t('entitlementBlocked')} className="team-agent-link-chip">
        {t('entitlementBlocked')}
      </WorkspaceChip>
    );
  }
  return (
    <span className="team-agent-link">
      <WorkspaceChip tone="warn" label={t('linkConnectSoty')} className="team-agent-link-chip">
        {t('linkConnectSoty')}
      </WorkspaceChip>
      <ReconnectAction surface="team_shell" size="xs" />
    </span>
  );
}
