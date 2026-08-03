import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { initDashboardAuth, installAuthorizedFetch } from './auth.js';
import './index.css';

initDashboardAuth();
installAuthorizedFetch();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
