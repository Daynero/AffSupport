import { useEffect } from 'react';
import { AgentProvider, useAgent } from './AgentContext';
import { Header } from './App';
import { ProfileOnboarding } from './auth/AuthScreens';
import HomePage from './HomePage';
import FeatureLockDialog from './components/FeatureLockDialog';
import { useFeatureLock, type FeatureId } from './lib/feature-flags';
import { toolByPath, type WebTool } from './lib/tool-registry';
import type { SotyToolId } from '@video-compressor/shared';
import { useI18n } from './i18n';
import { navigateTo, usePageEntrance } from './lib/navigation';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';
import LocalAppDialog from './components/LocalAppDialog';
import ReleaseUpdateNotice from './components/ReleaseUpdateNotice';
import { SupportGoalProvider } from './support/SupportGoalContext';
import { teamApi } from './api/team';
import { PowerProvider } from './lib/power';
import { TeamProvider } from './team/TeamContext';
import TeamSpace from './team/TeamSpace';
import { parseTeamRoute } from './team/routes';

export default function ProtectedSoty({ path, route = path }: { path: string; route?: string }) {
  return (
    <AgentProvider>
      <PowerProvider>
        <SupportGoalProvider>
          <TeamProvider client={teamApi}>
            <ApplicationShell path={path} route={route} />
          </TeamProvider>
          <ReleaseUpdateNotice />
          <ProfileOnboarding />
        </SupportGoalProvider>
      </PowerProvider>
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
function ApplicationShell({ path, route }: { path: string; route: string }) {
  const { language, setLanguage, t } = useI18n();
  const { connection } = useAgent();
  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} connection={connection} t={t} />
      <div className="page-viewport">
        <ProtectedApplication path={path} route={route} />
      </div>
    </div>
  );
}

function ProtectedApplication({ path, route }: { path: string; route: string }) {
  const tool = toolByPath(path);
  if (tool) return <ToolRoute tool={tool} />;
  if (path === '/account') return <AccountPage />;
  if (path === '/admin') return <AdminPage />;
  // Team mode owns everything under /team: the space id and section live in the
  // path, so an exact match would have made every addressable section a 404.
  // The full route (not just the pathname) is parsed because the query half —
  // search, filters, open task, folder position — is part of the address.
  const teamRoute = parseTeamRoute(route);
  if (teamRoute) return <TeamSpace route={teamRoute} />;
  return <HomePage navigate={navigateTo} />;
}

function ToolRoute({ tool }: { tool: WebTool }) {
  const { connection, capabilities, connectedOnce, toolAvailable } = useAgent();
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
  // D1/FR-039. The setup screen is for someone who has to *do* something —
  // install the app, or update it. It is not for someone whose wifi dropped
  // for two seconds: unmounting the tool page there throws away form input,
  // scroll position and any dialog they had open, and then offers to install
  // software they are already running. Anyone who has connected once keeps
  // their page.
  if (connectedOnce && connection !== 'agent_update_required') return <tool.page />;
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
  tool: SotyToolId;
  connection: ReturnType<typeof useAgent>['connection'];
}) {
  // Setup ↔ tool swaps remount this branch; the entrance animation makes the
  // "not connected → connected" switch fade instead of popping. Retry ticks
  // (AgentContext keeps its state during background retries) never remount.
  const entering = usePageEntrance();
  return (
    <>
      <main className={entering ? 'page-container page-enter' : 'page-container'} />
      <LocalAppDialog tool={tool} connection={connection} onClose={() => navigateTo('/', true)} />
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
