import React from 'react';
import ReactDOM from 'react-dom/client';

/**
 * Fonts are BUNDLED, never fetched.
 *
 * The station runs on a shop's LAN with no guarantee of internet — §7.1 is explicit
 * that there is no inbound dependency, and a `<link>` to Google Fonts would make the
 * app's typography depend on an outbound one. Importing here makes Vite emit the
 * woff2 files into the bundle the API serves, so no network call is ever attempted.
 */
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/700.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/700.css';

import './styles/globals.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
