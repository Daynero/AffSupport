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
import { navigateTo, usePageEntrance } from './lib/navigation';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';
import LocalAppDialog from './components/LocalAppDialog';
import ReleaseUpdateNotice from './components/ReleaseUpdateNotice';
import { SupportGoalProvider } from './support/SupportGoalContext';
import { teamApi } from './api/team';
import { TeamProvider } from './team/TeamContext';
import TeamSpace from './team/TeamSpace';

export default function ProtectedWishly({ path }: { path: string }) {
  return (
    <AgentProvider>
      <SupportGoalProvider>
        <TeamProvider client={teamApi}>
          <ApplicationShell path={path} />
        </TeamProvider>
        <ReleaseUpdateNotice />
        <ProfileOnboarding />
      </SupportGoalProvider>
    </AgentProvider>
  );
}

/**
 * Persistent shell: the topbar (and the .app-shell frame) mounts once and
 * stays mounted across every in-app route change — only the content inside
 * .page-viewport swaps. The viewport also forms the `wishly-page`
 * view-transition group while a route transition runs (navigation.ts +
 * styles.css), so the header never crossfades with the page content.
 */
function ApplicationShell({ path }: { path: string }) {
  const { language, setLanguage, t } = useI18n();
  const { connection } = useAgent();
  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
      <div className="page-viewport">
        <ProtectedApplication path={path} />
      </div>
    </div>
  );
}

function ProtectedApplication({ path }: { path: string }) {
  const tool = toolByPath(path);
  if (tool) return <ToolRoute tool={tool} />;
  if (path === '/account') return <AccountPage />;
  if (path === '/admin') return <AdminPage />;
  if (path === '/team') return <TeamSpace />;
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
  // Setup ↔ tool swaps remount this branch; the entrance animation makes the
  // "not connected → connected" switch fade instead of popping. Retry ticks
  // (AgentContext keeps its state during background retries) never remount.
  const entering = usePageEntrance();
  return (
    <>
      <main className={entering ? 'page-container page-enter' : 'page-container'} />
      <LocalAppDialog tool={tool} connection={connection} />
    </>
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
  return (
    <>
      <main className="page-container" />
      <FeatureLockDialog
        feature={feature}
        onUnlocked={() => {
          /* Unlock event re-renders the parent, which mounts the tool. */
        }}
        onClose={() => navigateTo('/', true)}
      />
    </>
  );
}
