// First, before any client captures `fetch` (lib/fetch-activity.ts).
import './lib/install-fetch-activity';
import React from 'react';
import ReactDOM from 'react-dom/client';
import Root from './Root';
import { consumePairingToken } from './api/pairing-token';
import { healModuleGraph } from './lib/healModuleCache';
import { initialLanguage, loadLanguage } from './i18n';
// One entry, because the order the sheets load in is a cascade decision and it
// belongs in a cascade file. `styles/index.css` declares the layer ladder and
// imports every sheet into its place; see the comment at the top of it.
import './styles/index.css';

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
  // The failed chunk and everything it imports: the poisoned file may be one of its imports.
  const start =
    href ?? document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (!start) return reload();
  void healModuleGraph(start).then(reload, reload);
});

// The reader's dictionary before the first render (070 T072): `translate` is synchronous, and the
// other language is downloaded only if they switch to it. A failed load still renders — the
// chunk-recovery above may already be reloading the page.
const root = ReactDOM.createRoot(document.getElementById('root')!);
void loadLanguage(initialLanguage())
  .catch(() => undefined)
  .then(() =>
    root.render(
      <React.StrictMode>
        <Root />
      </React.StrictMode>
    )
  );
