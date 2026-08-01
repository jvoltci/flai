import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/* v4.0 shipped a service worker that stitched 16 MB slices into one download. It is gone — the
 * server does that internally now — but a browser that loaded that version still has it
 * registered and controlling this page, where it would intercept every request and answer a
 * download URL that no longer exists.
 *
 * Deploying a build without a service worker does not remove one. It has to be told. */
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
