/**
 * A minimal Chrome DevTools Protocol client — no dependencies, by constraint.
 *
 * Playwright is not in this repo and the standing rule for this work is "no new
 * dependencies", so the capture harness talks to Chrome directly. Node 24 ships a
 * global `WebSocket`, which is the only thing that made a third-party client
 * necessary in the first place; everything else here is `child_process`, `fetch`
 * and `fs`.
 *
 * Deliberately small: connect, send a command, await its reply, subscribe to an
 * event. No auto-waiting, no selector engine, no retries — the capture script does
 * its own waiting, explicitly, so that every "wait" in the shot list is a stated
 * condition rather than a library's guess.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (raw) => {
      const msg = JSON.parse(raw.data);
      if (msg.id !== undefined) {
        const entry = this.#pending.get(msg.id);
        if (!entry) return;
        this.#pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45_000);
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
    return () => {
      const list = this.#listeners.get(method);
      list.splice(list.indexOf(fn), 1);
    };
  }

  once(method, predicate = () => true) {
    return new Promise((resolve) => {
      const off = this.on(method, (params) => {
        if (!predicate(params)) return;
        off();
        resolve(params);
      });
    });
  }
}

/** Launch headless Chrome and attach a flattened session to one blank tab. */
export async function launch({ chromePath } = {}) {
  const bin =
    chromePath ??
    CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('No Chrome or Edge binary found — pass chromePath.');

  const profile = mkdtempSync(join(tmpdir(), 'walaa-qa-'));
  const port = 9333;
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // The capture must not race a background throttle: a hidden/occluded headless
      // tab otherwise stops rAF, and recharts' entry animation never completes.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--lang=ar-IQ',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Chrome did not open a debugging port.');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const close = async () => {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    child.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the profile briefly; a temp dir is not worth failing on. */
    }
  };

  return { cdp, sessionId, close };
}

export { sleep };
