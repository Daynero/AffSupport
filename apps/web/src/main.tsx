import React from 'react';
import ReactDOM from 'react-dom/client';
import Root from './Root';
import { consumePairingToken } from './api/pairing-token';
import './styles.css';

document.documentElement.dataset.appBoot = '2026-08-09.1';

// Before the first render, and therefore before the sign-in redirect can rewrite
// the URL. The Agent hands its token over in the fragment of the page it opens
// (`/local` → `…/#agentToken=…`), and that page is the sign-in screen whenever
// this origin has no session yet. Reading it any later loses it, which is why an
// app the Agent had just opened could claim not to find the Agent.
consumePairingToken();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
