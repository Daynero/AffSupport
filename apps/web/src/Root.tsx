import { useEffect, useState, type MouseEvent } from 'react';
import CompressorPage from './App';
import { AgentProvider } from './AgentContext';
import { useAgent } from './AgentContext';
import HomePage from './HomePage';
import { translate, detectLanguage } from './i18n';

export default function Root() {
  return (
    <AgentProvider>
      <Routes />
    </AgentProvider>
  );
}

function Routes() {
  const [path, setPath] = useState(location.pathname);
  const { state } = useAgent();
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  const navigate = (next: string) => {
    if (next === location.pathname) return;
    history.pushState(null, '', next);
    setPath(next);
  };
  const goHome = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href="/"]');
    if (!anchor || path !== '/compressor') return;
    event.preventDefault();
    if (state.running) {
      const language = detectLanguage(localStorage.getItem('language'), navigator.languages);
      if (!confirm(translate(language, 'leaveCompressorConfirm'))) return;
    }
    navigate('/');
  };
  return (
    <div onClick={goHome}>
      {path === '/compressor' ? <CompressorPage /> : <HomePage navigate={navigate} />}
    </div>
  );
}

export function routeKind(path: string): 'home' | 'compressor' {
  return path === '/compressor' ? 'compressor' : 'home';
}
