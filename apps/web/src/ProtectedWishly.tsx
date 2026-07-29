import { useEffect } from 'react';
import { AgentProvider, useAgent } from './AgentContext';
import { Header } from './App';
import { ProfileOnboarding } from './auth/AuthScreens';
import HomePage from './HomePage';
import FeatureLockDialog from './components/FeatureLockDialog';
import { useFeatureLock, type FeatureId } from './lib/feature-flags';
import { toolByPath, type WebTool } from './lib/tool-registry';
import type { WishlyToolId } from '@video-compressor/shared';
import { useI18n } from './i18n';
import { navigateTo } from './lib/navigation';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';
import LocalAppDialog from './components/LocalAppDialog';
import ReleaseUpdateNotice from './components/ReleaseUpdateNotice';

export default function ProtectedWishly({ path }: { path: string }) {
  return (
    <AgentProvider>
      <ProtectedApplication path={path} />
      <ReleaseUpdateNotice />
      <ProfileOnboarding />
    </AgentProvider>
  );
}

function ProtectedApplication({ path }: { path: string }) {
  const { language, setLanguage, t } = useI18n();
  const { connection } = useAgent();
  const tool = toolByPath(path);
  if (tool) return <ToolRoute tool={tool} />;
  if (path === '/account' || path === '/admin') {
    return (
      <div className="app-shell">
        <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
        {path === '/account' ? <AccountPage /> : <AdminPage />}
      </div>
    );
  }
  return <HomePage navigate={navigateTo} />;
}

function ToolRoute({ tool }: { tool: WebTool }) {
  const { connection, capabilities, toolAvailable } = useAgent();
  // Web-only access gate — a protected tool must show the lock even on a
  // direct URL visit until this browser has acknowledged the warning.
  const locked = useToolLock(tool.featureFlag);
  if (locked && tool.featureFlag) return <FeatureLockScreen feature={tool.featureFlag} />;
  if (tool.capability) {
    if (capabilities.includes(tool.capability) && toolAvailable(tool.id)) return <tool.page />;
    // A connected agent without the capability cannot serve this tool — send the
    // user home. Before connecting, keep the page mounted so it can pair/onboard.
    if (connection === 'connected') return <RedirectHome />;
    return <tool.page />;
  }
  if (connection === 'connected' && toolAvailable(tool.id)) return <tool.page />;
  return <ToolSetupScreen tool={tool.id} connection={connection} />;
}

/**
 * Reactive lock for a tool's feature flag. Hooks must run unconditionally, so
 * flag-less tools evaluate an always-open flag and ignore the result.
 */
function useToolLock(feature: FeatureId | null): boolean {
  const locked = useFeatureLock(feature ?? 'videoCompressor');
  return feature !== null && locked;
}

function ToolSetupScreen({
  tool,
  connection
}: {
  tool: WishlyToolId;
  connection: ReturnType<typeof useAgent>['connection'];
}) {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
      <main className="page-container" />
      <LocalAppDialog tool={tool} connection={connection} />
    </div>
  );
}

function RedirectHome() {
  useEffect(() => navigateTo('/', true), []);
  return <HomePage navigate={navigateTo} />;
}

/**
 * Shown when a protected feature is opened by direct URL. The developer-pass
 * modal sits over the standard shell; unlocking flips the reactive lock so the
 * parent re-renders the real tool, and closing returns to the tools home.
 */
function FeatureLockScreen({ feature }: { feature: FeatureId }) {
  const { language, setLanguage, t } = useI18n();
  const { connection } = useAgent();
  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
      <FeatureLockDialog
        feature={feature}
        onUnlocked={() => {
          /* Unlock event re-renders the parent, which mounts the tool. */
        }}
        onClose={() => navigateTo('/', true)}
      />
    </div>
  );
}
