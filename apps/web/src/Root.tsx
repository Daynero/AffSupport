import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { I18nProvider } from 'react-aria-components/I18nProvider';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { EnvironmentBadge } from './components/EnvironmentBadge';
import {
  AuthCallbackPage,
  AuthHandoffPage,
  AuthLoadingScreen,
  AuthRecoveryScreen,
  BlockedAccountScreen,
  ConfigErrorScreen,
  LoginPage
} from './auth/AuthScreens';
import {
  HANDOFF_PATH,
  claimHandoffAttempt,
  handoffRequestUrl,
  sessionHandoffOrigin
} from './auth/session-handoff';
import PublicHomePage from './PublicHomePage';
import { loginUrl } from './lib/redirects';
import { navigateTo, useBrowserRoute } from './lib/navigation';
import { useI18n } from './i18n';

const ProtectedSoty = lazy(() => import('./ProtectedSoty'));
/**
 * The inventory's demo surface (021). Development only: `import.meta.env.DEV`
 * is a compile-time constant, so the whole branch — and the module behind it —
 * is dropped from a production bundle rather than merely unreachable in it.
 */
const DesignSystemPage = import.meta.env.DEV ? lazy(() => import('./dev/DesignSystemPage')) : null;
const PrivacyPage = lazy(() =>
  import('./pages/LegalPages').then(module => ({ default: module.PrivacyPage }))
);
const TermsPage = lazy(() =>
  import('./pages/LegalPages').then(module => ({ default: module.TermsPage }))
);

/**
 * The decorative backdrop, loaded after the application is usable.
 *
 * It is a full-viewport SVG field with a pointer-driven animation and it is
 * purely decoration: nothing about the product stops working without it. Having
 * it in the entry bundle meant every user waited for it before the first screen
 * could render, including a user who came to compress one file and leave.
 *
 * No Suspense fallback, because there is nothing to wait for — the page is
 * complete without it and it fades in when it arrives.
 */
const HoneycombField = lazy(() =>
  import('./components/HoneycombField').then(module => ({ default: module.HoneycombField }))
);

export default function Root() {
  /*
   * The library's locale, tied to the product's own (024).
   *
   * Dates, week starts, number formats and the words inside a calendar's
   * announcements all come from here. Without it React Aria reads the browser's
   * locale, which is how a Ukrainian interface came to draw a week that starts
   * on Sunday.
   */
  const { language } = useI18n();
  return (
    <I18nProvider locale={language === 'uk' ? 'uk-UA' : 'en-GB'}>
      <AuthProvider>
        <Suspense fallback={null}>
          <HoneycombField />
        </Suspense>
        <EnvironmentBadge />
        <Routes />
      </AuthProvider>
    </I18nProvider>
  );
}

function Routes() {
  const route = useBrowserRoute();
  const path = new URL(route, location.origin).pathname;
  const auth = useAuth();

  if (path === '/privacy')
    return (
      <Suspense fallback={<LegalLoadingScreen />}>
        <PrivacyPage />
      </Suspense>
    );
  if (path === '/terms')
    return (
      <Suspense fallback={<LegalLoadingScreen />}>
        <TermsPage />
      </Suspense>
    );
  if (path === '/design' && DesignSystemPage) {
    return (
      <Suspense fallback={<AuthLoadingScreen />}>
        <DesignSystemPage />
      </Suspense>
    );
  }
  if (path === '/auth/callback') return <AuthCallbackPage />;
  if (path === HANDOFF_PATH) return <AuthHandoffPage />;
  if (path === '/login') return <LoginPage />;

  const decision = protectedRouteDecision({
    status: auth.status,
    hasSession: Boolean(auth.session),
    hasProfile: Boolean(auth.profile),
    accountStatus: auth.profile?.account_status ?? null,
    configurationError: auth.error === 'configuration'
  });
  if (decision === 'loading') return <AuthLoadingScreen />;
  // In the Agent's copy of the app, a missing session is usually a session that
  // simply lives on the other origin. Ask for it before showing anything that
  // looks like "sign in again"; the marketing page below is the website's job.
  if (decision === 'login' && sessionHandoffOrigin()) return <AskWebsiteForSession route={route} />;
  if (path === '/' && (decision === 'configuration-error' || decision === 'login'))
    return <PublicHomePage />;
  if (decision === 'configuration-error') return <ConfigErrorScreen />;
  if (decision === 'recovery') return <AuthRecoveryScreen />;
  if (decision === 'login') return <RedirectToLogin route={route} />;
  if (decision === 'blocked') return <BlockedAccountScreen />;
  if (decision === 'deleted') return <BlockedAccountScreen deleted />;

  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <ProtectedSoty path={path} route={route} />
    </Suspense>
  );
}

function LegalLoadingScreen() {
  return (
    <div className="legal-page">
      <AuthLoadingScreen />
    </div>
  );
}

function RedirectToLogin({ route }: { route: string }) {
  useEffect(() => navigateTo(loginUrl(route), true), [route]);
  return <AuthLoadingScreen />;
}

/**
 * Leaves for the website to fetch a session, or gives up and shows sign-in.
 *
 * The claim is made in an effect rather than during render: it is a counter, and
 * a render may happen twice.
 */
function AskWebsiteForSession({ route }: { route: string }) {
  const [asking, setAsking] = useState(true);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = handoffRequestUrl(route);
    if (url && claimHandoffAttempt()) location.assign(url);
    else setAsking(false);
  }, [route]);
  return asking ? <AuthLoadingScreen /> : <RedirectToLogin route={route} />;
}

// Tool-path classification (routeKind) lives in lib/tool-registry.ts. Root must
// not import the registry: it would pull every tool page into the eager entry
// chunk, defeating the lazy ProtectedSoty split above.

export function protectedRouteDecision(input: {
  status: ReturnType<typeof useAuth>['status'];
  hasSession: boolean;
  hasProfile: boolean;
  accountStatus: 'active' | 'blocked' | 'deleted' | null;
  configurationError: boolean;
}): 'loading' | 'configuration-error' | 'recovery' | 'login' | 'blocked' | 'deleted' | 'allow' {
  if (['initializing', 'authenticating', 'signing-out'].includes(input.status)) return 'loading';
  if (input.configurationError) return 'configuration-error';
  if (input.status === 'error' && input.hasSession) return 'recovery';
  if (input.status !== 'authenticated' || !input.hasSession) return 'login';
  if (!input.hasProfile) return 'recovery';
  if (input.accountStatus === 'blocked') return 'blocked';
  if (input.accountStatus === 'deleted') return 'deleted';
  return 'allow';
}
