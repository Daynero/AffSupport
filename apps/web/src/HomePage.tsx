import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Header, Onboarding } from './App';
import { useAgent } from './AgentContext';
import { useI18n, type TranslationKey } from './i18n';
import { analytics } from './analytics/service';

type Tool = {
  id: string;
  title: TranslationKey;
  description: TranslationKey;
  icon: ReactNode;
  route: string | null;
  status: 'active' | 'coming-soon';
};

export const wishlyTools: Tool[] = [
  {
    id: 'compressor',
    title: 'videoCompressor',
    description: 'videoCompressorDescription',
    icon: <CompressorIcon />,
    route: '/compressor',
    status: 'active'
  },
  {
    id: 'transcription',
    title: 'transcription',
    description: 'transcriptionDescription',
    icon: <TranscriptionIcon />,
    route: null,
    status: 'coming-soon'
  }
];

// The Landing Optimizer needs a matching agent (the /api/landing routes), so it
// is only offered when the connected agent advertises the `landing` capability.
// This lets the web ship ahead of the agent without exposing a dead tool.
export const landingTool: Tool = {
  id: 'landing-optimizer',
  title: 'landingOptimizer',
  description: 'landingOptimizerDescription',
  icon: <LandingIcon />,
  route: '/landing-optimizer',
  status: 'active'
};

export function toolsForCapabilities(capabilities: readonly string[]): Tool[] {
  if (!capabilities.includes('landing')) return wishlyTools;
  return [wishlyTools[0], landingTool, ...wishlyTools.slice(1)];
}

export default function HomePage({ navigate }: { navigate: (path: string) => void }) {
  const { language, setLanguage, t } = useI18n();
  const { connection, reconnect, capabilities } = useAgent();
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const connected = connection === 'connected';
  const tools = toolsForCapabilities(capabilities);

  useEffect(() => {
    document.title = 'Wishly — Tools';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', 'A collection of local Wishly tools for working with your files.');
    analytics.track('home_viewed', {});
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const openTool = (tool: Tool) => {
    if (tool.status !== 'active') {
      analytics.track('transcription_interest_clicked', { tool_identifier: 'transcription' });
      return;
    }
    if (connected && tool.route) navigate(tool.route);
    else {
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
          {tools.map(tool => {
            const available = tool.status === 'active' && connected;
            return (
              <article
                key={tool.id}
                className={`tool-card tool-${tool.status} ${available ? 'is-available' : ''}`}
                onClick={() => openTool(tool)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openTool(tool);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-disabled={tool.status === 'active' && !connected ? true : undefined}
              >
                <div className="tool-card-top">
                  <span className="tool-icon" aria-hidden="true">
                    {tool.icon}
                  </span>
                  {tool.status === 'coming-soon' && (
                    <span className="soon-badge">{t('comingSoon')}</span>
                  )}
                </div>
                <div className="tool-copy">
                  <h3>{t(tool.title)}</h3>
                  <p>{t(tool.description)}</p>
                </div>
                {tool.status === 'active' && (
                  <div className="tool-action-row">
                    <span className={`tool-readiness ${connected ? 'ready' : ''}`}>
                      {t(connected ? 'readyToWork' : 'agentRequired')}
                    </span>
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
    </div>
  );
}

function CompressorIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <rect x="5" y="7" width="22" height="18" rx="4" />
      <path d="m12 12 4 4-4 4m8-8-4 4 4 4" />
    </svg>
  );
}
function LandingIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <rect x="5" y="6" width="22" height="20" rx="3" />
      <path d="M5 11h22M9 16h9m-9 4h6" />
      <path d="m21 20 2.5 2.5L27 18" />
    </svg>
  );
}
function TranscriptionIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M8 12v8m4-12v16m4-12v8m4-14v20m4-14v8" />
    </svg>
  );
}
