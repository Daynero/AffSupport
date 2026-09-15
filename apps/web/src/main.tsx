import React from 'react';
import ReactDOM from 'react-dom/client';
import Root from './Root';
import { consumePairingToken } from './api/pairing-token';
import './styles.css';
import './styles/team-accounts.css';
import './styles/team-tasks.css';
import './styles/transcription.css';
import './styles/landing-viewer.css';

document.documentElement.dataset.appBoot = '2026-08-09.1';

// Before the first render, and therefore before the sign-in redirect can rewrite
// the URL. The Agent hands its token over in the fragment of the page it opens
// (`/local` → `…/#agentToken=…`), and that page is the sign-in screen whenever
// this origin has no session yet. Reading it any later loses it, which is why an
// app the Agent had just opened could claim not to find the Agent.
consumePairingToken();

/*
 * A lazy chunk that will not load after the page has started.
 *
 * The same poisoned cache the boot recovery in index.html heals can hit a chunk loaded later: the
 * host answered it with the app's HTML mid-deploy and the browser keeps that answer for hours. The
 * chunk is fetched again past the cache and the page reloads once; a second failure in the same tab
 * is left to surface, so a chunk that is really gone cannot loop the page.
 */
const CHUNK_RECOVERY_KEY = 'soty.chunk-recovery.v1';
// A page that has been up for a while has recovered; a later deploy may need the same help again.
window.setTimeout(() => {
  try {
    sessionStorage.removeItem(CHUNK_RECOVERY_KEY);
  } catch {
    // Storage unavailable: recovery simply stays one-shot for this tab.
  }
}, 15_000);
window.addEventListener('vite:preloadError', event => {
  const key = CHUNK_RECOVERY_KEY;
  const message = String((event as Event & { payload?: unknown }).payload ?? '');
  const href = /https?:\/\/\S+?\.(?:js|css)\b/u.exec(message)?.[0];
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    return;
  }
  event.preventDefault();
  const reload = () => window.location.reload();
  if (!href) return reload();
  void fetch(href, { cache: 'reload', credentials: 'same-origin' }).then(reload, reload);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
