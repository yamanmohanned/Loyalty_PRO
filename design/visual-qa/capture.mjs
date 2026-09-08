/**
 * Visual-QA capture harness.
 *
 * Drives the RUNNING dashboard against the RUNNING API through headless Chrome and
 * writes the review set to `design/visual-qa/shots/`. It is a review instrument, not
 * part of the product: nothing here is imported by the app and it adds no dependency
 * to any package (see `cdp.mjs` for why it talks to Chrome directly).
 *
 * Two properties are deliberate and worth knowing before reading a shot:
 *
 *  1. **Every pixel comes from the real API.** The only exception is the three state
 *     frames (loading / empty / error), which are produced by holding, replacing or
 *     failing the `/reports/overview` response at the network layer. Those three are
 *     labelled as such in `VISUAL-QA.md`, because a screenshot of an empty state is a
 *     picture of a UI state and must never be mistaken for a picture of the data.
 *
 *  2. **"Full page" means a tall viewport, not a tall document.** This app pins
 *     `body { overflow: hidden }` and scrolls inside `<main>`, so the document is
 *     never taller than the window and `captureBeyondViewport` would return the fold
 *     and nothing else. Each full-page frame therefore measures `main.scrollHeight`,
 *     resizes the viewport to it, waits for the charts to re-lay-out at the new size,
 *     and captures. That is a real render at that height, not a stitch.
 *
 * Usage:  node design/visual-qa/capture.mjs
 * Needs:  API on :4001 (pnpm --filter @walaa/api dev:alt)
 *         dashboard on :5180 (pnpm --filter @walaa/manager-desktop dev:alt)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'shots');
const APP = 'http://localhost:5180';
const API = process.env.WALAA_QA_API ?? 'http://localhost:4001';
const CREDENTIALS = {
  username: 'manager',
  password: process.env.WALAA_QA_PASSWORD ?? 'Walaa!Dev2026',
};

// 1366 is the merchant's likely laptop, so it is a review width, not a spot check.
const WIDTHS = [1440, 1366, 1280, 1024];
const FOLD_HEIGHT = 900;
const DSF = 2;

mkdirSync(OUT, { recursive: true });

const manifest = [];
let cdp;
let session;

/* ── CDP conveniences ─────────────────────────────────────────────────────── */

const call = (method, params) => cdp.send(method, params, session);

async function evaluate(expression) {
  const { result, exceptionDetails } = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' — ' + (exceptionDetails.exception?.description ?? ''));
  return result.value;
}

async function setViewport(width, height) {
  await call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: DSF,
    mobile: false,
  });
}

/** PNG dimensions, read from the IHDR chunk — the capture's own self-check. */
function pngSize(buffer) {
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

async function shot(name, { clip } = {}) {
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) {
    /*
      `scale: 1`, and this was measured rather than read.

      The first run asked for `scale: DSF` on the assumption that a clipped capture
      ignores the emulated device scale factor — the behaviour the protocol docs
      imply. It does not: `header-1440.png` came out 4448 px wide for a 1112 px CSS
      rect, which is 4x, so the emulation and the clip scale had compounded. The
      `pngSize` check below is in this file precisely so that assumption had to
      survive contact with a real byte count.
    */
    params.clip = { ...clip, scale: 1 };
  }
  const { data } = await call('Page.captureScreenshot', params);
  const buffer = Buffer.from(data, 'base64');
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, buffer);
  const { w, h } = pngSize(buffer);
  manifest.push({ name, w, h });
  console.log(`  ${name}.png  ${w}×${h}`);
  return file;
}

/** A clip rect for a DOM node, in CSS pixels, relative to the viewport. */
async function rectOf(finder, pad = 0) {
  const r = await evaluate(`(() => {
    const el = (${finder})();
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  })()`);
  if (!r) throw new Error(`No element for clip: ${finder}`);
  return {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  };
}

/* ── In-page helpers, injected as source so `rectOf` can take a finder ────── */

const FIND = {
  aside: `() => document.querySelector('aside')`,
  header: `() => document.querySelector('main header')`,
  kpiRow: `() => document.querySelectorAll('main .grid')[0]`,
  activityRow: `() => {
    const h = [...document.querySelectorAll('main h2')].find(n => n.textContent.includes('مؤشرات النشاط'));
    return h ? h.parentElement.nextElementSibling : null;
  }`,
  card: (title) => `() => {
    const h = [...document.querySelectorAll('main h2')].find(n => n.textContent.trim() === ${JSON.stringify(title)});
    return h ? h.closest('div[class*="rounded-card"]') : null;
  }`,
};

/* ── Waiting, stated explicitly ───────────────────────────────────────────── */

/**
 * Hold until the frame is genuinely finished: fonts resolved, no shimmer left in
 * the DOM, and every recharts area path carrying real geometry.
 *
 * The last condition is the one that matters. Recharts animates its area in on
 * mount, and a screenshot taken during that animation shows a path clipped to a
 * fraction of its width — which looks like a rendering bug in a review sheet and is
 * not one. `d.length` growing then settling is the signal that it finished.
 */
async function settle({ charts = true, timeout = 15_000 } = {}) {
  await evaluate('document.fonts.ready.then(() => true)');
  const deadline = Date.now() + timeout;
  let previous = '';
  let stableFor = 0;

  while (Date.now() < deadline) {
    const state = await evaluate(`(() => {
      const shimmer = document.querySelectorAll('.animate-shimmer').length;
      const paths = [...document.querySelectorAll('.recharts-area-area, .recharts-area-curve')]
        .map(p => (p.getAttribute('d') || '').length).join(',');
      const sectors = document.querySelectorAll('.recharts-pie-sector').length;
      const hasArea = document.querySelectorAll('.recharts-area').length > 0;
      return JSON.stringify({ shimmer, paths, sectors, hasArea });
    })()`);
    const parsed = JSON.parse(state);
    // A page with no area chart has no path geometry to wait for, and demanding it
    // anyway is what made every non-Overview screen time out on the first run:
    // Reports draws HTML bars and a funnel, so `paths` is legitimately empty there.
    const chartsReady = !charts || !parsed.hasArea || parsed.paths.length > 0;
    if (parsed.shimmer === 0 && chartsReady && state === previous) {
      stableFor += 1;
      if (stableFor >= 3) return;
    } else {
      stableFor = 0;
    }
    previous = state;
    await sleep(200);
  }
  console.warn('  ! settle() timed out — the frame may be mid-render');
}

/* ── Session ──────────────────────────────────────────────────────────────── */

async function bootAndLogin() {
  await call('Page.navigate', { url: APP });
  await cdp.once('Page.loadEventFired');
  // Skip the first-run setup screen the way a browser dev session does: outside
  // Tauri, `config.ts` reads the server URL straight out of localStorage.
  await evaluate(`window.localStorage.setItem('api_url', ${JSON.stringify(API)}), true`);
  await call('Page.reload');
  await cdp.once('Page.loadEventFired');
  await sleep(900);

  const ok = await evaluate(`(() => {
    // React-controlled inputs ignore a plain value assignment; the native setter
    // plus a bubbling 'input' event is what react-hook-form's register listens for.
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const user = inputs.find(i => i.type !== 'password');
    const pass = inputs.find(i => i.type === 'password');
    if (!user || !pass) return false;
    setValue(user, ${JSON.stringify(CREDENTIALS.username)});
    setValue(pass, ${JSON.stringify(CREDENTIALS.password)});
    const submit = document.querySelector('button[type="submit"]');
    if (!submit) return false;
    submit.click();
    return true;
  })()`);
  if (!ok) throw new Error('Login form not found.');

  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('main')`)) break;
    await sleep(250);
  }
  if (!(await evaluate(`!!document.querySelector('main')`))) throw new Error('Login did not complete.');
  await settle();
}

/** Client-side route change — a hard navigate would drop the in-memory tokens. */
async function goRoute(hash) {
  await evaluate(`(() => {
    const link = [...document.querySelectorAll('aside a')].find(a => a.getAttribute('href') === ${JSON.stringify(hash)});
    if (link) { link.click(); return true; }
    location.hash = ${JSON.stringify(hash)};
    return true;
  })()`);
  await sleep(700);
  await settle();
}

/**
 * Grow the viewport to the whole scrollable page, run `fn`, then restore.
 *
 * **`Page.captureScreenshot` with a `clip` cannot see past the viewport**, and
 * `captureBeyondViewport` does not help here because this app scrolls inside
 * `<main>` rather than growing the document. The first run took every block crop at
 * 900 px tall and `activity-cards-1440.png` came back as an empty grey rectangle —
 * the clip was correct and pointed at pixels that had never been rasterised.
 *
 * Scrolling the element into view instead would work, but it changes what is on
 * screen between one crop and the next; making the viewport tall enough to hold the
 * page means every crop is taken from one render of one layout.
 */
async function withTallViewport(width, fn) {
  await setViewport(width, FOLD_HEIGHT);
  await sleep(400);
  const height = await evaluate(`(() => {
    const m = document.querySelector('main');
    m.scrollTop = 0;
    return Math.ceil(m.scrollHeight + (document.body.scrollHeight - m.clientHeight));
  })()`);
  await setViewport(width, Math.max(FOLD_HEIGHT, Math.min(height + 24, 6000)));
  await sleep(600);
  await settle();
  try {
    await fn();
  } finally {
    await setViewport(width, FOLD_HEIGHT);
    await sleep(300);
  }
}

/** Resize the viewport to the whole scrollable page and capture it in one render. */
async function fullPage(name, width) {
  await setViewport(width, FOLD_HEIGHT);
  await sleep(400);
  const height = await evaluate(`(() => {
    const m = document.querySelector('main');
    m.scrollTop = 0;
    return Math.ceil(m.scrollHeight + (document.body.scrollHeight - m.clientHeight));
  })()`);
  await setViewport(width, Math.max(FOLD_HEIGHT, Math.min(height + 24, 6000)));
  await sleep(600);
  await settle();
  await shot(name);
  await setViewport(width, FOLD_HEIGHT);
  await sleep(300);
}

/* ── Interaction ──────────────────────────────────────────────────────────── */

async function mouseTo(x, y) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(250);
}

async function pressTab(times = 1) {
  for (let i = 0; i < times; i++) {
    for (const type of ['keyDown', 'keyUp']) {
      await call('Input.dispatchKeyEvent', {
        type,
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
    }
    await sleep(90);
  }
}

/* ── Network-level state injection (the three state frames only) ──────────── */

const OVERVIEW_PATTERN = '*reports/overview*';

async function withInterception(mode, fn) {
  await call('Fetch.enable', { patterns: [{ urlPattern: OVERVIEW_PATTERN, requestStage: 'Request' }] });
  const off = cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      if (mode === 'hold') return; // never continued — the skeleton stays up
      if (mode === 'fail') {
        await call('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        return;
      }
      if (mode === 'empty') {
        /*
          **The injected response has to carry CORS headers, or it is not an empty
          state — it is an error state wearing one.**

          The dashboard runs on :5180 and the API on :4001, so every call is
          cross-origin and the bearer token makes it preflighted. The first attempt
          fulfilled the GET with a bare `content-type`, the browser refused the
          response for want of `access-control-allow-origin`, `api.get` threw, and
          `state-empty-1440.png` came back showing «حدث خطأ». The frame was a
          faithful screenshot of the wrong state, which is the most expensive kind of
          wrong in a review sheet.
        */
        const cors = [
          { name: 'access-control-allow-origin', value: 'http://localhost:5180' },
          { name: 'access-control-allow-credentials', value: 'true' },
          { name: 'access-control-allow-headers', value: '*' },
          { name: 'access-control-allow-methods', value: 'GET,OPTIONS' },
        ];
        if (request.method === 'OPTIONS') {
          await call('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
          return;
        }
        const body = JSON.stringify({
          overview: {
            totalCustomers: 0,
            newCustomersInRange: 0,
            capturedInvoices: 0,
            attributedInvoices: 0,
            attributionRatePct: 0,
            capturedSales: 0,
            discountsGranted: 0,
            averageBasket: 0,
            timeseries: [],
            topCustomers: [],
            recentTransactions: [],
          },
        });
        await call('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...cors],
          body: Buffer.from(body).toString('base64'),
        });
      }
    } catch {
      /* the tab may have moved on; an interception that misses is not fatal here */
    }
  });

  try {
    await fn();
  } finally {
    off();
    await call('Fetch.disable');
  }
}

/** Force a refetch of the overview query without a page reload. */
async function refetchOverview() {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('main button')]
      .find(b => (b.getAttribute('aria-label') || '') === 'تحديث البيانات');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
}

/* ── The run ──────────────────────────────────────────────────────────────── */

async function main() {
  const launched = await launch();
  cdp = launched.cdp;
  session = launched.sessionId;

  try {
    await call('Page.enable', {}, session);
    await call('Runtime.enable', {}, session);
    await call('Network.enable', {}, session);
    await call('Emulation.setLocaleOverride', { locale: 'ar-IQ' }, session);
    await call('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Baghdad' }, session);
    await setViewport(1440, FOLD_HEIGHT);

    console.log('› booting');
    await bootAndLogin();

    /* (a) Overview, full page and fold, at each width. */
    for (const width of WIDTHS) {
      console.log(`› overview @ ${width}`);
      await setViewport(width, FOLD_HEIGHT);
      await sleep(500);
      await settle();
      await shot(`overview-fold-${width}`);
      await fullPage(`overview-full-${width}`, width);
    }

    /* (a2) The KPI figure must fit its tile at every width — measured, not eyeballed. */
    console.log('› kpi fit');
    for (const width of WIDTHS) {
      await setViewport(width, FOLD_HEIGHT);
      await sleep(500);
      /*
        Measured with a Range over the element's CONTENTS, not `scrollWidth`.

        `.amount` is a block-level `<p>`: it fills its container by definition, so
        `scrollWidth === clientWidth` on every tile at every width and the first
        version of this check cheerfully reported "0 px slack" everywhere — a
        measurement that could not fail, which is the same as no measurement. A Range
        measures the painted glyphs.
      */
      const fit = await evaluate(`(() => {
        const row = document.querySelectorAll('main .grid')[0];
        return [...row.children].map(card => {
          const v = card.querySelector('.amount');
          if (!v) return null;
          const r = document.createRange();
          r.selectNodeContents(v);
          return {
            txt: v.textContent.trim(),
            w: Math.round(r.getBoundingClientRect().width),
            box: Math.round(v.parentElement.getBoundingClientRect().width),
          };
        }).filter(Boolean);
      })()`);
      const worst = fit.reduce((a, b) => (b.box - b.w < a.box - a.w ? b : a));
      const overflow = fit.filter((f) => f.w > f.box);
      console.log(`    ${width}: tightest "${worst.txt}" ${worst.w}/${worst.box}px (${worst.box - worst.w}px slack)` + (overflow.length ? `  OVERFLOW x${overflow.length}` : ''));
    }

    /* (b) The rail, either side of its breakpoint. */
    console.log('› sidebar');
    for (const width of [1440, 1366, 1280, 1279, 1200, 1024]) {
      await setViewport(width, FOLD_HEIGHT);
      await sleep(450);
      const railWidth = await evaluate(`document.querySelector('aside').getBoundingClientRect().width`);
      const label = railWidth > 200 ? 'expanded' : 'rail';
      await shot(`sidebar-${label}-${width}`, { clip: await rectOf(FIND.aside) });
      console.log(`    ${width} → aside ${railWidth}px (${label})`);
    }

    /* (c)–(d) Blocks, close-cropped at 1440. */
    await setViewport(1440, FOLD_HEIGHT);
    await sleep(500);
    await settle();

    console.log('› blocks @ 1440');
    await withTallViewport(1440, async () => {
    await shot('header-1440', { clip: await rectOf(FIND.header, 12) });
    await shot('kpi-row-1440', { clip: await rectOf(FIND.kpiRow, 10) });

    // The bidi crop: both delta pills live in the KPI row, one positive and one
    // negative, which is exactly the pair the fix has to be judged on.
    await shot('bidi-deltas-1440', { clip: await rectOf(FIND.kpiRow, 10) });

    const donut = await rectOf(FIND.card('توزيع الفواتير الملتقطة'), 8);
    await shot('attribution-donut-1440', { clip: donut });

    // Tooltip on a peak: recharts marks each real reading with a dot; the highest
    // one is the smallest `cy`. Hovering the dot rather than a guessed coordinate is
    // what makes this reproducible.
    const peak = await evaluate(`(() => {
      const h = [...document.querySelectorAll('main h2')].find(n => n.textContent.includes('المبيعات الملتقطة عبر الوقت'));
      const card = h.closest('div[class*="rounded-card"]');
      const dots = [...card.querySelectorAll('.recharts-dot')];
      if (!dots.length) return null;
      const top = dots.reduce((a, b) => (+a.getAttribute('cy') < +b.getAttribute('cy') ? a : b));
      const r = top.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (peak) {
      await mouseTo(peak.x, peak.y);
      await sleep(400);
    }
    await shot('sales-chart-tooltip-1440', {
      clip: await rectOf(FIND.card('المبيعات الملتقطة عبر الوقت'), 8),
    });
    await mouseTo(4, 4);

    await shot('top-customers-1440', { clip: await rectOf(FIND.card('أفضل الزبائن'), 8) });
    await shot('activity-cards-1440', { clip: await rectOf(FIND.activityRow, 10) });

    // Row hover: a real mousemove, so the CSS :hover actually engages.
    const row = await evaluate(`(() => {
      const tr = document.querySelectorAll('main table tbody tr')[2];
      if (!tr) return null;
      const r = tr.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (row) await mouseTo(row.x, row.y);
    await shot('table-hover-1440', { clip: await rectOf(FIND.card('أحدث الفواتير'), 8) });
    await mouseTo(4, 4);
    });

    /* (e) States. Focus first — it needs the live page. */
    console.log('› states @ 1440');
    await evaluate(`document.querySelector('main').scrollTop = 0; true`);
    await sleep(300);
    /*
      Tab until focus lands INSIDE <main>.

      The first run pressed Tab six times and clipped to the header — and the frame
      contained no ring at all, because the rail comes first in the DOM (it is the
      right-hand column under RTL) and six tabs were still inside it. A fixed number
      of key presses is a guess about DOM order; this waits for the condition the
      shot is actually about.
    */
    let focused = 'none';
    for (let i = 0; i < 24; i++) {
      await pressTab(1);
      const where = await evaluate(`(() => {
        const a = document.activeElement;
        if (!a || !document.querySelector('main').contains(a)) return null;
        return a.tagName + ': ' + (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40);
      })()`);
      if (where) { focused = where; break; }
    }
    console.log(`    focus on → ${focused}`);
    await shot('state-focus-ring-1440', {
      clip: await rectOf(`() => document.activeElement.closest('div,header') || document.activeElement`, 20),
    });

    await withInterception('hold', async () => {
      await call('Page.reload');
      await cdp.once('Page.loadEventFired');
      await sleep(1200);
      await evaluate(`(() => {
        const setValue = (el, v) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')];
        const user = inputs.find(i => i.type !== 'password');
        const pass = inputs.find(i => i.type === 'password');
        setValue(user, ${JSON.stringify(CREDENTIALS.username)});
        setValue(pass, ${JSON.stringify(CREDENTIALS.password)});
        document.querySelector('button[type="submit"]').click();
        return true;
      })()`);
      await sleep(2500);
      await shot('state-loading-1440');
    });

    // Back to a live session for the remaining two states.
    await call('Page.reload');
    await cdp.once('Page.loadEventFired');
    await sleep(900);
    await bootAndLoginAfterReload();

    await withInterception('empty', async () => {
      await refetchOverview();
      await sleep(2000);
      await settle({ charts: false });
      const body = await evaluate(`document.querySelector('main').innerText`);
      if (body.includes('حدث خطأ')) {
        throw new Error('state-empty captured the ERROR state — the injected response was rejected.');
      }
      await shot('state-empty-1440');
    });

    await withInterception('fail', async () => {
      await refetchOverview();
      await sleep(2000);
      await shot('state-error-1440');
    });

    /* (g) Regression check on the screens the shared tokens also touch. */
    console.log('› regression');
    await call('Page.reload');
    await cdp.once('Page.loadEventFired');
    await sleep(900);
    await bootAndLoginAfterReload();
    await goRoute('#/reports');
    await fullPage('reports-full-1440', 1440);
    await goRoute('#/customers');
    await shot('customers-fold-1440');
    await goRoute('#/cards');
    await shot('cards-fold-1440');
    await goRoute('#/discounts');
    await shot('discounts-fold-1440');

    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\n${manifest.length} frames written to ${OUT}`);
  } finally {
    await launched.close();
  }
}

/** The login form again, for the reloads the state frames force. */
async function bootAndLoginAfterReload() {
  await evaluate(`(() => {
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const user = inputs.find(i => i.type !== 'password');
    const pass = inputs.find(i => i.type === 'password');
    if (!user || !pass) return false;
    setValue(user, ${JSON.stringify(CREDENTIALS.username)});
    setValue(pass, ${JSON.stringify(CREDENTIALS.password)});
    document.querySelector('button[type="submit"]').click();
    return true;
  })()`);
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('main')`)) break;
    await sleep(250);
  }
  await settle();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
