import { useEffect, useRef, useState } from 'react';
import { Header, Onboarding } from './App';
import { useAgent } from './AgentContext';
import { useI18n } from './i18n';
import { analytics } from './analytics/service';
import FeatureLockDialog from './components/FeatureLockDialog';
import { isLocked } from './lib/feature-flags';
import LocalAppDialog from './components/LocalAppDialog';
import { webTools, type WebTool } from './lib/tool-registry';

export default function HomePage({ navigate }: { navigate: (path: string) => void }) {
  const { language, setLanguage, t } = useI18n();
  const { connection, reconnect, toolAvailable } = useAgent();
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedTool, setLockedTool] = useState<WebTool | null>(null);
  const [setupTool, setSetupTool] = useState<WebTool | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = 'Wishly — Tools';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', 'A collection of local Wishly tools for working with your files.');
    analytics.track('home_viewed', {});
    for (const tool of webTools) {
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

  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
      <main className="launcher">
        <div className="launcher-heading">
          <h2>{t('toolsTitle')}</h2>
          <p>{t('toolsSubtitle')}</p>
        </div>

        {notice && (
          <div className="launcher-notice" role="status">
            {notice}
          </div>
        )}

        <div className="agent-panel-slot" ref={panel} tabIndex={-1}>
          {connection === 'checking' ? (
            <div className="agent-checking" role="status">
              {t('connectingAgent')}
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
          {webTools.map(tool => {
            const openable = tool.status !== 'coming-soon';
            const underDevelopment = tool.status === 'in-development';
            const available = openable && connected && toolAvailable(tool.id);
            return (
              <article
                key={tool.id}
                className={`tool-card tool-${openable ? 'active' : 'coming-soon'} ${available ? 'is-available' : ''}`}
                onClick={() => openTool(tool)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openTool(tool);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-disabled={openable && !connected ? true : undefined}
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
                      <span className={`tool-readiness ${connected ? 'ready' : ''}`}>
                        {t(connected ? 'readyToWork' : 'agentRequired')}
                      </span>
                    )}
                    <span className={`button button-primary ${available ? '' : 'is-disabled'}`}>
                      {t('openTool')}
                    </span>
                  </div>
                )}
              </article>
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
            if (connected) navigate(tool.path);
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
    </div>
  );
}
