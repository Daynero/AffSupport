import { lazy, Suspense, useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import {
  AuthCallbackPage,
  AuthLoadingScreen,
  AuthRecoveryScreen,
  BlockedAccountScreen,
  ConfigErrorScreen,
  LoginPage
} from './auth/AuthScreens';
import { loginUrl } from './lib/redirects';
import { navigateTo, useBrowserRoute } from './lib/navigation';

const ProtectedWishly = lazy(() => import('./ProtectedWishly'));
const PrivacyPage = lazy(() =>
  import('./pages/LegalPages').then(module => ({ default: module.PrivacyPage }))
);
const TermsPage = lazy(() =>
  import('./pages/LegalPages').then(module => ({ default: module.TermsPage }))
);

export default function Root() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}

function Routes() {
  const route = useBrowserRoute();
  const path = new URL(route, location.origin).pathname;
  const auth = useAuth();

  if (path === '/privacy')
    return (
      <Suspense fallback={<AuthLoadingScreen />}>
        <PrivacyPage />
      </Suspense>
    );
  if (path === '/terms')
    return (
      <Suspense fallback={<AuthLoadingScreen />}>
        <TermsPage />
      </Suspense>
    );
  if (path === '/auth/callback') return <AuthCallbackPage />;
  if (path === '/login') return <LoginPage />;

  const decision = protectedRouteDecision({
    status: auth.status,
    hasSession: Boolean(auth.session),
    hasProfile: Boolean(auth.profile),
    accountStatus: auth.profile?.account_status ?? null,
    configurationError: auth.error === 'configuration'
  });
  if (decision === 'loading') return <AuthLoadingScreen />;
  if (decision === 'configuration-error') return <ConfigErrorScreen />;
  if (decision === 'recovery') return <AuthRecoveryScreen />;
  if (decision === 'login') return <RedirectToLogin route={route} />;
  if (decision === 'blocked') return <BlockedAccountScreen />;
  if (decision === 'deleted') return <BlockedAccountScreen deleted />;

  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <ProtectedWishly path={path} />
    </Suspense>
  );
}

function RedirectToLogin({ route }: { route: string }) {
  useEffect(() => navigateTo(loginUrl(route), true), [route]);
  return <AuthLoadingScreen />;
}

export function routeKind(path: string): 'home' | 'compressor' | 'landing-optimizer' {
  if (path === '/compressor') return 'compressor';
  if (path === '/landing-optimizer') return 'landing-optimizer';
  return 'home';
}

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
