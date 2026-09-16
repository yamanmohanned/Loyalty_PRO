import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from './config';

/** Whether the page reached the merchant's browser, and if not, whose refusal it was. */
export type OpenResult = { opened: true } | { opened: false; reason: 'blocked' | 'failed' };

/**
 * Opens a web address in the merchant's own browser.
 *
 * Inside the desktop shell `window.open` does nothing at all: the webview refuses the new
 * window, returns null, throws nothing and logs nothing — measured in the packaged window
 * on 2026-09-16, and the reason «ربط حساب Google» appeared dead. So the shell hands the
 * address to Windows through the opener plugin (`shell::open`), which `opener:default` in
 * `capabilities/default.json` permits for http and https. Outside the shell (the
 * development page in a browser) a new tab is the same thing.
 *
 * Never throws and never fails silently: the caller is told whether it opened and, if
 * not, whether the app's own permissions refused it or Windows did — each has its own
 * sentence and the address is still offered to copy.
 */
export async function openInBrowser(url: string): Promise<OpenResult> {
  if (isTauri()) {
    try {
      await openUrl(url);
      return { opened: true };
    } catch (error) {
      const detail = String(error);
      console.error('[external] the browser could not be opened', detail);
      return { opened: false, reason: /not allowed|permission|scope/i.test(detail) ? 'blocked' : 'failed' };
    }
  }
  // `noopener` makes `window.open` return null even when the tab opened, so its value
  // cannot tell success from a popup blocker; the waiting panel shows the link either way.
  window.open(url, '_blank', 'noopener,noreferrer');
  return { opened: true };
}
