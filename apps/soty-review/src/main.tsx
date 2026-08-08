import React from 'react';
import ReactDOM from 'react-dom/client';
import ReviewApp from './ReviewApp';
import './generated/soty-tokens.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('SOTY_REVIEW_ROOT_MISSING');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ReviewApp />
  </React.StrictMode>
);
