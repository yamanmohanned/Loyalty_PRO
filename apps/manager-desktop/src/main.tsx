import React from 'react';
import ReactDOM from 'react-dom/client';

/**
 * Fonts are BUNDLED, never fetched (CLAUDE_v2.md §3, §14).
 *
 * This is the single most common failure when converting a web app to a desktop
 * app: a `<link>` to Google Fonts works on the developer's machine and silently
 * falls back to a system face on a shop counter with no internet. Importing them
 * here makes Vite emit the woff2 files into the bundle, so no network call is ever
 * attempted.
 */
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/600.css';
import '@fontsource/cairo/700.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';

import './styles/globals.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
