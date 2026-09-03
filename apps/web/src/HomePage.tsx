import { useEffect, useRef, useState } from 'react';
import { Onboarding } from './App';
import { useAgent } from './AgentContext';
import { useI18n } from './i18n';
import { analytics } from './analytics/service';
import { Card } from './components/Card';
import FeatureLockDialog from './components/FeatureLockDialog';
import { isLocked } from './lib/feature-flags';
import { usePageEntrance } from './lib/navigation';
import LocalAppDialog from './components/LocalAppDialog';
import { TeamWorkspaceIcon } from './components/tool-icons';
import { catalogueTools, type AgentWebTool, type WebTool } from './lib/tool-registry';
import { teamApi } from './api/team';

export default function HomePage({ navigate }: { navigate: (path: string) => void }) {
  const { t } = useI18n();
  const { connection, connectedOnce, reconnect, toolAvailable } = useAgent();
  const entering = usePageEntrance();
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedTool, setLockedTool] = useState<WebTool | null>(null);
  const [setupTool, setSetupTool] = useState<AgentWebTool | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = 'Soty — Tools';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', 'A collection of local Soty tools for working with your files.');
    analytics.track('home_viewed', {});
    for (const tool of catalogueTools) {
      analytics.track('tool_impression', { tool_identifier: tool.analyticsId });
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const openTool = (tool: WebTool) => {
    analytics.track('tool_open_clicked', { tool_identifier: tool.analyticsId });
    if (tool.status === 'coming-soon') {
      analytics.track('transcription_interest_clicked', { tool_identifier: 'transcription' });
      return;
    }
    // Web-only access gate: a protected, not-yet-unlocked tool shows the
    // developer-pass modal instead of opening.
    if (tool.featureFlag && isLocked(tool.featureFlag)) {
      setLockedTool(tool);
      return;
    }
    // A browser tool has nothing to wait for. Running it through the checks
    // below would offer to install software it never calls, to someone whose
    // only problem is that the local app happens to be closed.
    if (tool.runtime === 'browser') {
      navigate(tool.path);
      return;
    }
    if (connected && toolAvailable(tool.id)) {
      navigate(tool.path);
    } else {
      analytics.track(connected ? 'tool_blocked_incompatible' : 'blocked_action_attempted', {
        tool_identifier: tool.analyticsId,
        action_identifier: 'open_tool',
        outcome: 'blocked'
      });
      setSetupTool(tool);
      panel.current?.focus();
      panel.current?.classList.remove('attention');
      requestAnimationFrame(() => panel.current?.classList.add('attention'));
    }
  };

  const openTeamWorkspace = () => {
    navigate('/team');
  };

  /**
   * Unanswered invitations, counted for the entry card's badge.
   *
   * Strictly non-blocking: the home screen must render for people with no team
   * access at all, so a failed or forbidden probe simply means no badge rather
   * than an error anywhere (finding I1).
   */
  const [pendingInvitations, setPendingInvitations] = useState(0);
  useEffect(() => {
    let active = true;
    void teamApi
      .listMyInvitations()
      .then(invitations => {
        if (active) {
          setPendingInvitations(
            invitations.filter(invitation => invitation.state === 'pending').length
          );
        }
      })
      .catch(() => {
        if (active) setPendingInvitations(0);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <main className={entering ? 'launcher page-enter' : 'launcher'}>
        <div className="launcher-heading">
          <h2>{t('toolsTitle')}</h2>
          <p>{t('toolsSubtitle')}</p>
        </div>

        {notice && (
          <div className="launcher-notice" role="status">
            {notice}
          </div>
        )}

        <Card
          as="article"
          interactive
          className="team-workspace-launcher-card"
          onClick={openTeamWorkspace}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openTeamWorkspace();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={
            pendingInvitations > 0
              ? t('teamWorkspaceWithInvitations', { count: pendingInvitations })
              : t('teamWorkspace')
          }
        >
          <div className="team-workspace-launcher-copy">
            <span className="tool-icon" aria-hidden="true">
              <TeamWorkspaceIcon />
            </span>
            <div>
              <div className="team-workspace-launcher-title">
                <h3>{t('teamWorkspace')}</h3>
                {pendingInvitations > 0 && (
                  <span className="ui-chip ui-chip-busy">
                    {t('teamInvitationBadge', { count: pendingInvitations })}
                  </span>
                )}
                <span className="soon-badge">{t('inDevelopment')}</span>
              </div>
              <p>{t('teamWorkspaceDescription')}</p>
            </div>
          </div>
          <span className="button button-primary">{t('openTool')}</span>
        </Card>

        <div className="agent-panel-slot" ref={panel} tabIndex={-1}>
          {connection === 'checking' ? (
            <div className="agent-checking" role="status">
              {t('connectingAgent')}
            </div>
          ) : !connected && connectedOnce ? (
            /* D2. Someone who has connected before does not need download
               instructions — they have the application; it is momentarily not
               answering. Offering to install it reads as "your install is
               broken", which is both wrong and alarming. */
            <div className="agent-checking" role="status">
              {t('agentReconnecting')}
            </div>
          ) : !connected ? (
            <Onboarding
              state={connection}
              help={help}
              setHelp={setHelp}
              connect={reconnect}
              t={t}
            />
          ) : null}
        </div>

        <section className="tool-grid" aria-label={t('toolsTitle')}>
          {catalogueTools.map(tool => {
            const openable = tool.status !== 'coming-soon';
            const underDevelopment = tool.status === 'in-development';
            const beta = tool.status === 'beta';
            const available =
              openable && (tool.runtime === 'browser' || (connected && toolAvailable(tool.id)));
            // The card told assistive technology it was disabled and then acted
            // on a click and on Enter anyway. Announcing a control as
            // unavailable and having it work is worse than either alone: it is
            // the one state a user cannot reason about.
            // A browser tool is never inert: there is nothing to connect to, so
            // "unavailable because the local app is closed" would be false.
            const inert = openable && tool.runtime === 'agent' && !connected;
            const activate = () => {
              if (inert) return;
              openTool(tool);
            };
            return (
              <Card
                as="article"
                key={tool.id}
                interactive={openable}
                className={`tool-card ${openable ? '' : 'tool-coming-soon'} ${available ? 'is-available' : ''}`}
                onClick={activate}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-disabled={inert ? true : undefined}
              >
                <div className="tool-card-top">
                  <span className="tool-icon" aria-hidden="true">
                    <tool.icon />
                  </span>
                  {tool.status === 'coming-soon' && (
                    <span className="soon-badge">{t('comingSoon')}</span>
                  )}
                  {underDevelopment && <span className="soon-badge">{t('inDevelopment')}</span>}
                </div>
                <div className="tool-copy">
                  <h3>{t(tool.labelKey)}</h3>
                  <p>{t(tool.descriptionKey)}</p>
                </div>
                {openable && (
                  <div className="tool-action-row">
                    {!underDevelopment && (
                      <span
                        className={`tool-readiness ${beta ? 'beta' : connected ? 'ready' : ''}`}
                      >
                        {t(beta ? 'betaTesting' : connected ? 'readyToWork' : 'agentRequired')}
                      </span>
                    )}
                    <span className={`button button-primary ${available ? '' : 'is-disabled'}`}>
                      {t('openTool')}
                    </span>
                  </div>
                )}
              </Card>
            );
          })}
        </section>
      </main>

      {lockedTool?.featureFlag && (
        <FeatureLockDialog
          feature={lockedTool.featureFlag}
          onClose={() => setLockedTool(null)}
          onUnlocked={() => {
            const tool = lockedTool;
            setLockedTool(null);
            if (tool.runtime === 'browser' || connected) navigate(tool.path);
          }}
        />
      )}
      {setupTool && (
        <LocalAppDialog
          tool={setupTool.id}
          connection={connection}
          onClose={() => setSetupTool(null)}
        />
      )}
    </>
  );
}
