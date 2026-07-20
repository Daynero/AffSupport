import { AgentProvider, useAgent } from './AgentContext';
import CompressorPage, { Header } from './App';
import LandingOptimizerPage from './landing/LandingOptimizerPage';
import { ProfileOnboarding } from './auth/AuthScreens';
import HomePage from './HomePage';
import { useI18n } from './i18n';
import { navigateTo } from './lib/navigation';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';

export default function ProtectedWishly({ path }: { path: string }) {
  return (
    <AgentProvider>
      <ProtectedApplication path={path} />
      <ProfileOnboarding />
    </AgentProvider>
  );
}

function ProtectedApplication({ path }: { path: string }) {
  const { language, setLanguage, t } = useI18n();
  const { connection } = useAgent();

  if (path === '/compressor') return <CompressorPage />;
  if (path === '/landing-optimizer') return <LandingOptimizerPage />;
  if (path === '/account' || path === '/admin') {
    return (
      <div className="app-shell">
        <Header
          language={language}
          setLanguage={setLanguage}
          connection={connection}
          t={t}
        />
        {path === '/account' ? <AccountPage /> : <AdminPage />}
      </div>
    );
  }
  return <HomePage navigate={navigateTo} />;
}
