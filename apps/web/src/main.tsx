import React from 'react';
import ReactDOM from 'react-dom/client';
import Root from './Root';
import './styles.css';

document.documentElement.dataset.appBoot = '2026-08-09.1';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
