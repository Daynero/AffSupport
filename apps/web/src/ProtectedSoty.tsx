import { Suspense, type ComponentType, useEffect, useState } from 'react';
import { AgentProvider, useAgent, useAgentStatus } from './AgentContext';
import { Header } from './App';
import { ProfileOnboarding } from './auth/AuthScreens';
import HomePage from './HomePage';
import FeatureLockDialog from './components/FeatureLockDialog';
import { useFeatureLock, type FeatureId } from './lib/feature-flags';
import { toolByPath, type WebTool } from './lib/tool-registry';
import { useI18n } from './i18n';
import { navigateTo, registerRoutePreparer } from './lib/navigation';
import { useInstallHandoff } from './lib/install-handoff';
import { recoverableLazy } from './lib/recoverable-lazy';
import { HintLayer, RouteSkeleton } from './components/ui/index';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';
import { ToolSetupState } from './components/ToolSetupState';
import ReleaseUpdateNotice from './components/ReleaseUpdateNotice';
import { NextChannelBadge } from './components/NextChannelBadge';
import { ReleaseTesterGate } from './components/ReleaseTesterGate';
import { SupportGoalProvider } from './support/SupportGoalContext';
import { teamApi } from './api/team';
import { PowerProvider } from './lib/power';
import { TeamProvider } from './team/TeamContext';
import { parseTeamRoute } from './team/routes';
import { useSpaceOffersReconnect } from './components/ReconnectAction';
import { RestitchBackgroundPreparation } from './team/restitch/restitch-background';

const teamSpace = recoverableLazy(() => import('./team/TeamSpace').then(module => module.default));
const TeamSpace = teamSpace.Component;

/*
 * Every navigation into a tool or a space waits for that screen's code (up to
 * the skeleton delay) before the route changes (058, FR-007). For a space that
 * is the space screen and the workspace shell behind it — the shell is what
 * fills the screen, and arriving without it would crossfade into a skeleton.
 */
registerRoutePreparer(path => {
  const pathname = path.split(/[?#]/u, 1)[0] ?? path;
  const tool = toolByPath(pathname);
  if (tool) return tool.preload();
  if (pathname !== '/team' && !pathname.startsWith('/team/')) return;
  const pending = [
    teamSpace.preload(),
    import('./team/TeamSpace').then(module => module.preloadWorkspaceShell())
  ].filter(Boolean);
  return pending.length > 0 ? Promise.all(pending) : undefined;
});

export default function ProtectedSoty({ path, route = path }: { path: string; route?: string }) {
  return (
    <AgentProvider>
      <PowerProvider>
        <SupportGoalProvider>
          <ReleaseTesterGate>
            <TeamProvider client={teamApi}>
              <ApplicationShell path={path} route={route} />
            </TeamProvider>
            <ReleaseUpdateNotice />
            <ProfileOnboarding />
          </ReleaseTesterGate>
          <NextChannelBadge />
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
  const { t } = useI18n();
  // Status only: this sits above every page and has no interest in a
  // progress tick.
  const { connection } = useAgentStatus();
  // The tab the installer came from follows the app into the space once it connects (070).
  useInstallHandoff(connection, path);
  // A space's header carries its own reconnect (070 T031); while it is on screen the bar
  // keeps the fact and drops its copy of the button, so the screen has one (070 T069).
  const spaceReconnects = useSpaceOffersReconnect();
  return (
    <div className="app-shell">
      <HintLayer />
      {/* 071: the open space prepares its videos for re-stitching while Soty is free. */}
      <RestitchBackgroundPreparation />
      <Header connection={connection} t={t} reconnect={!spaceReconnects} />
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
  if (teamRoute)
    return (
      <Suspense
        fallback={
          <main className="page-container team-space-page">
            <RouteSkeleton variant={teamRoute.kind === 'space' ? 'workspace' : 'lobby'} />
          </main>
        }
      >
        <TeamSpace route={teamRoute} />
      </Suspense>
    );
  return <HomePage navigate={navigateTo} />;
}

function ToolRoute({ tool }: { tool: WebTool }) {
  const { connection, capabilities, connectedOnce, releaseBlocked, toolAvailable } =
    useAgentStatus();
  // Web-only access gate — a protected tool must show the lock even on a
  // direct URL visit until this browser has acknowledged the warning.
  const locked = useToolLock(tool.featureFlag);
  if (locked && tool.featureFlag) return <FeatureLockScreen feature={tool.featureFlag} />;
  // Nothing below this line applies to a tool that runs in the browser: there is
  // no capability to check, no version to be compatible with, and no setup
  // screen that would tell the truth.
  if (tool.runtime === 'browser') return <ToolPage tool={tool} />;
  if (tool.capability) {
    if (capabilities.includes(tool.capability) && toolAvailable(tool.id))
      return <ToolPage tool={tool} />;
    // A connected agent without the capability cannot serve this tool — send the
    // user home. Before connecting, keep the page mounted so it can pair/onboard.
    if (connection === 'connected') return <RedirectHome />;
    return <ToolPage tool={tool} />;
  }
  // An installation the signed manifest no longer supports does not get to open
  // a tool and find out the hard way. This is checked before every other path,
  // including the one that keeps a page mounted through a dropped connection:
  // "you have connected before" is not a reason to keep using a build that is
  // known broken.
  if (releaseBlocked) return <ToolSetupState tool={tool} connection="agent_update_required" />;
  if (connection === 'connected' && toolAvailable(tool.id)) return <ToolPage tool={tool} />;
  // D1/FR-039. The setup screen is for someone who has to *do* something —
  // install the app, or update it. It is not for someone whose wifi dropped
  // for two seconds: unmounting the tool page there throws away form input,
  // scroll position and any dialog they had open, and then offers to install
  // software they are already running. Anyone who has connected once keeps
  // their page.
  if (connectedOnce && connection !== 'agent_update_required') return <ToolPage tool={tool} />;
  return <ToolSetupGate tool={tool} connection={connection} />;
}

/**
 * How long the first connection check may take before the setup dialog is
 * shown (058, FR-008). The check usually answers in well under a second; the
 * dialog used to open for that moment and close again as the tool appeared.
 * Mirrors `--delay-patience` in tokens.css.
 */
const FIRST_CHECK_PATIENCE_MS = 1_200;

function ToolSetupGate({
  tool,
  connection
}: {
  tool: WebTool;
  connection: ReturnType<typeof useAgent>['connection'];
}) {
  const checking = connection === 'checking';
  const [patient, setPatient] = useState(checking);
  useEffect(() => {
    if (!checking) {
      setPatient(false);
      return;
    }
    const timer = window.setTimeout(() => setPatient(false), FIRST_CHECK_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, [checking]);
  if (checking && patient)
    return (
      <main className="page-container">
        <RouteSkeleton variant="tool" />
      </main>
    );
  return <ToolSetupState tool={tool} connection={connection} />;
}

/**
 * Reactive lock for a tool's feature flag. Hooks must run unconditionally, so
 * flag-less tools evaluate an always-open flag and ignore the result.
 */
function useToolLock(feature: FeatureId | null): boolean {
  const locked = useFeatureLock(feature ?? 'videoCompressor');
  return feature !== null && locked;
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

/**
 * Renders a tool page behind a Suspense boundary.
 *
 * The pages are loaded on demand, so React needs somewhere to wait while the
 * chunk arrives. A navigation waits for the chunk first (058), so this is
 * rarely reached; when it is, the tool's skeleton fades in — after the
 * skeleton delay, so a chunk that is only a moment late shows nothing at all
 * rather than a flash.
 */
function ToolPage({ tool }: { tool: { page: ComponentType } }) {
  return (
    <Suspense
      fallback={
        <main className="page-container">
          <RouteSkeleton variant="tool" />
        </main>
      }
    >
      <tool.page />
    </Suspense>
  );
}
