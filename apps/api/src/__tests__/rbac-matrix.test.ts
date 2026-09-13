import { PrismaClient } from '@prisma/client';
import type { Role } from '@walaa/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * Who can reach what (CLAUDE.md §7.2, §7.12).
 *
 * ## Why a whole file
 *
 * Authentication here is opt-OUT — a global hook protects every route and only an
 * explicit marker lets one through — which makes a *silently public* endpoint nearly
 * impossible. It does nothing about the other half: a route that is authenticated but
 * names no roles is open to every role there is, and reads in review exactly like a
 * route that meant to be.
 *
 * Six of them were, until the V3-6 security pass. It made no practical difference at the
 * time, because "any role" and "the Station's roles" happened to be the same set while
 * there were only three roles — and then the same pass added a fourth. `AGENT` would
 * have inherited, on the day it was created, the ability to register customers, redeem
 * vouchers, search customers by name and read card numbers: everything its cleartext
 * password on the cashier PC exists to keep it away from.
 *
 * So the matrix is written down, and every route is in it.
 *
 * ## How it reads
 *
 * RBAC is enforced in `onRequest`, before body validation, so a denied request answers
 * 403 whatever it was carrying. That is what lets this table be a table: allowed rows
 * assert only "not 403" — a 400 for an empty body is a pass, because the question here
 * is who gets through the door, not what they do inside.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;

/** Fixture usernames, by the role each one carries. */
const ACCOUNT: Record<Role, string> = {
  OWNER: 'owner',
  MANAGER: 'manager',
  STATION: 'station',
  AGENT: 'agent',
};

const ALL_ROLES = Object.keys(ACCOUNT) as Role[];
const DASHBOARD: Role[] = ['OWNER', 'MANAGER'];
const STATION: Role[] = ['OWNER', 'MANAGER', 'STATION'];
const INGEST: Role[] = ['OWNER', 'AGENT'];

const tokens = new Map<Role, string>();

interface Case {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  allowed: Role[];
  why?: string;
}

const CASES: Case[] = [
  /* Auth — deliberately open to every authenticated role (see auth.routes). */
  { method: 'GET', path: '/auth/me', allowed: ALL_ROLES },
  { method: 'POST', path: '/auth/logout-all', allowed: ALL_ROLES },

  /* The core loop. */
  {
    method: 'POST',
    path: '/ingest/invoice',
    allowed: INGEST,
    why: 'the agent declares sales; a tablet on the shop floor does not',
  },
  {
    method: 'POST',
    path: '/scan/identify',
    allowed: STATION,
    why: 'step 1 of the guided flow reads a customer; the capture agent never should',
  },
  { method: 'POST', path: '/scan/card', allowed: STATION },
  { method: 'POST', path: '/sync/batch', allowed: STATION },

  /* Customers. */
  { method: 'GET', path: '/customers/resolve?identifier=07701234567', allowed: STATION },
  { method: 'GET', path: '/customers/search?query=Ali', allowed: STATION },
  { method: 'POST', path: '/customers', allowed: STATION },
  {
    method: 'GET',
    path: '/customers?page=1',
    allowed: DASHBOARD,
    why: 'the till answers "who is this?"; browsing the whole list is a manager act',
  },
  {
    method: 'POST',
    path: '/customers/export',
    allowed: DASHBOARD,
    why: 'the file carries every phone number in the shop',
  },
  {
    method: 'GET',
    path: '/customers/00000000-0000-4000-8000-000000000000/card',
    allowed: STATION,
  },
  { method: 'GET', path: '/customers/00000000-0000-4000-8000-000000000000/cards', allowed: STATION },
  { method: 'GET', path: '/customers/00000000-0000-4000-8000-000000000000', allowed: DASHBOARD },
  { method: 'PATCH', path: '/customers/00000000-0000-4000-8000-000000000000', allowed: DASHBOARD },

  /* Physical card stock (§12.25).
   *
   * Split along one line: **batches are inventory, the card lifecycle is a counter
   * action.** Ordering stock and exporting a file that contains every card number in
   * it belong to the person who paid for the cards. Reporting a card lost, restoring
   * one, and issuing a replacement all happen while the customer is standing there,
   * and routing them through the manager would mean telling somebody to come back
   * when the owner is in.
   *
   * Voiding is the deliberate exception on the station side: it destroys stock, it is
   * never urgent, and nobody at a till should be able to write off a drawer of cards.
   */
  { method: 'GET', path: '/cards/batches', allowed: DASHBOARD },
  { method: 'POST', path: '/cards/batches', allowed: DASHBOARD },
  {
    method: 'POST',
    path: '/cards/batches/00000000-0000-4000-8000-000000000000/export',
    allowed: DASHBOARD,
    why: 'the export carries every card number in the batch',
  },
  { method: 'POST', path: '/cards/batches/00000000-0000-4000-8000-000000000000/void', allowed: DASHBOARD },
  { method: 'GET', path: '/cards/00000000-0000-4000-8000-000000000000', allowed: STATION },
  { method: 'POST', path: '/cards/00000000-0000-4000-8000-000000000000/lost', allowed: STATION },
  {
    method: 'POST',
    path: '/cards/00000000-0000-4000-8000-000000000000/restore',
    allowed: STATION,
    why: '"I found it" is answered at the counter, not next week',
  },
  { method: 'POST', path: '/cards/00000000-0000-4000-8000-000000000000/replace', allowed: STATION },
  { method: 'POST', path: '/cards/00000000-0000-4000-8000-000000000000/replace-thermal', allowed: STATION },
  {
    method: 'POST',
    path: '/cards/00000000-0000-4000-8000-000000000000/void',
    allowed: DASHBOARD,
    why: 'writing off stock is the owner\'s call, and never urgent',
  },

  /* Vouchers — redeemed at the till, voided and reconciled by a manager. */
  {
    method: 'POST',
    path: '/vouchers/00000000-0000-4000-8000-000000000000/redeem',
    allowed: STATION,
  },
  {
    method: 'POST',
    path: '/vouchers/00000000-0000-4000-8000-000000000000/void',
    allowed: DASHBOARD,
  },
  { method: 'GET', path: '/vouchers/reconciliation', allowed: DASHBOARD },

  /* Rules and modules. */
  { method: 'GET', path: '/discount', allowed: DASHBOARD },
  { method: 'PUT', path: '/discount/settings', allowed: DASHBOARD },
  { method: 'PUT', path: '/discount/rules', allowed: DASHBOARD },
  { method: 'POST', path: '/discount/assess', allowed: DASHBOARD },
  { method: 'GET', path: '/flags', allowed: STATION, why: 'the Station needs to know whether card printing is on' },
  { method: 'PUT', path: '/flags/cloud_backup', allowed: DASHBOARD },

  /* Backup and the key ceremony (§12.19). */
  { method: 'GET', path: '/backup', allowed: DASHBOARD },
  { method: 'GET', path: '/backup/key', allowed: DASHBOARD },
  { method: 'POST', path: '/backup/key/generate', allowed: ['OWNER'] },
  { method: 'POST', path: '/backup/key/reveal', allowed: ['OWNER'] },
  {
    method: 'POST',
    path: '/backup/key/confirm',
    allowed: DASHBOARD,
    why: 'whoever holds the printed key can complete the ceremony',
  },
  { method: 'POST', path: '/backup/run', allowed: DASHBOARD },
  { method: 'POST', path: '/backup/verify', allowed: DASHBOARD },

  /*
    ── Google Drive, and why connecting is OWNER-only ────────────────────────

    Reading the state of the link, adjusting how many copies are kept, and pressing
    "test" are operational: a manager doing the daily work needs them, and none of
    them can give anything away.

    **Connecting and disconnecting bind or unbind a Google account**, which is a
    decision about where this shop's encrypted customer data is allowed to go. That is
    the owner's to make, on the same reasoning that reserves the backup key ceremony to
    him — and disconnecting is listed beside connecting deliberately, because silently
    ending off-site backup is the more dangerous half of the pair.
  */
  { method: 'GET', path: '/backup/drive', allowed: DASHBOARD },
  { method: 'GET', path: '/backup/drive/connect/status', allowed: DASHBOARD },
  { method: 'POST', path: '/backup/drive/connect', allowed: ['OWNER'] },
  { method: 'POST', path: '/backup/drive/disconnect', allowed: ['OWNER'] },
  { method: 'PATCH', path: '/backup/drive/settings', allowed: DASHBOARD },
  { method: 'POST', path: '/backup/drive/test', allowed: DASHBOARD },
  // Restoring a copy replaces the whole ledger and signs everyone out: the owner only.
  { method: 'POST', path: '/backup/restore/stage', allowed: ['OWNER'] },
  { method: 'DELETE', path: '/backup/restore/stage', allowed: ['OWNER'] },
  { method: 'POST', path: '/backup/restore/apply', allowed: ['OWNER'] },

  /* Reports and host telemetry. */
  { method: 'GET', path: '/reports/overview', allowed: DASHBOARD },
  { method: 'GET', path: '/reports/programme', allowed: DASHBOARD },
  { method: 'GET', path: '/system/storage', allowed: DASHBOARD },
  // Whether captures are arriving: a manager's question, not the till's.
  { method: 'GET', path: '/system/capture', allowed: DASHBOARD },
  // The station's roll width (§5). Dashboard-only on purpose: the Station has no
  // settings screen by design (§6.4), and which paper is loaded is a fact about the
  // shop rather than about an operator's shift.
  { method: 'GET', path: '/system/printing', allowed: DASHBOARD },
  { method: 'PUT', path: '/system/printing', allowed: DASHBOARD },
  // A dashboard screen that crashed while drawing, into the service log (the
  // «الرقم المرجعي» on the crash card). Dashboard-only: the Station has its own UI and
  // an unauthenticated caller must not be able to write to the log at all.
  { method: 'POST', path: '/system/client-errors', allowed: DASHBOARD },

  /* ── Staff accounts ─────────────────────────────────────────────────────────

     OWNER only, not `DASHBOARD`. A MANAGER can read every report and rewrite the
     discount ladder; minting a login is the one act that widens who can reach the
     shop at all, and a MANAGER able to create a STATION account could create a
     second identity that the audit trail then attributes to the till. */
  { method: 'GET', path: '/users', allowed: ['OWNER'] },
  { method: 'POST', path: '/users', allowed: ['OWNER'] },
  { method: 'PATCH', path: '/users/:id', allowed: ['OWNER'] },
];

async function tokenFor(role: Role): Promise<string> {
  const cached = tokens.get(role);
  if (cached) return cached;

  const response = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    payload: { username: ACCOUNT[role], password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`login failed for ${ACCOUNT[role]}`);

  const token = response.json().tokens.accessToken as string;
  tokens.set(role, token);
  return token;
}

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
  // Built once: the matrix reads and denies, and nothing in it depends on a fresh
  // world. Rebuilding per case would also invalidate the cached tokens.
  await resetDatabase(prisma);
  await createWorld(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('the role matrix', () => {
  for (const testCase of CASES) {
    const denied = ALL_ROLES.filter((role) => !testCase.allowed.includes(role));
    const label = `${testCase.method} ${testCase.path.split('?')[0]}`;

    it(`${label} — ${testCase.allowed.join('/')}${testCase.why ? ` (${testCase.why})` : ''}`, async () => {
      for (const role of testCase.allowed) {
        const response = await app.inject({
          method: testCase.method,
          url: `${API_PREFIX}${testCase.path}`,
          headers: { authorization: `Bearer ${await tokenFor(role)}` },
          ...(testCase.method === 'GET' ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${role} should reach ${label}`).not.toBe(403);
      }

      for (const role of denied) {
        const response = await app.inject({
          method: testCase.method,
          url: `${API_PREFIX}${testCase.path}`,
          headers: { authorization: `Bearer ${await tokenFor(role)}` },
          ...(testCase.method === 'GET' ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${role} must not reach ${label}`).toBe(403);
      }
    });
  }

  it('refuses every route in the matrix without a token', async () => {
    for (const testCase of CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: `${API_PREFIX}${testCase.path}`,
      });
      expect(response.statusCode, `${testCase.method} ${testCase.path}`).toBe(401);
    }
  });
});

/**
 * The guard on the matrix itself.
 *
 * A matrix is only worth having if it is complete, and nothing about adding a route
 * reminds anybody that this file exists. So the route table is pinned: register a new
 * endpoint and this fails, and the way to make it pass is to say who may reach it.
 */
describe('the route inventory', () => {
  /**
   * Every route the server actually serves, as `METHOD /full/path`.
   *
   * Reconstructed from Fastify's printed radix trie by concatenating each node's label
   * with its ancestors', because the trie splits paths wherever two routes diverge —
   * `/api/v1/scan/card` is stored as `a` + `pi/v1/` + `s` + `can/card`. Printing the
   * leaves alone would give a list of fragments that no reviewer could check.
   */
  function routeTable(): string[] {
    const segments: string[] = [];
    const routes: string[] = [];

    for (const line of app.printRoutes().split('\n')) {
      const branch = line.search(/[├└]/u);
      if (branch === -1) continue;

      // Four characters of gutter per level: "│   " for a continuing ancestor,
      // then "├── " or "└── " for this node.
      const depth = Math.floor(branch / 4);
      const label = line.slice(branch + 4).trim();

      if (label === '(empty root node)') {
        segments[depth] = '';
        continue;
      }

      const withMethods = /^(.*?)\s+\(([A-Z, ]+)\)$/u.exec(label);
      segments.length = depth + 1;
      segments[depth] = withMethods ? withMethods[1]! : label;

      if (withMethods) {
        routes.push(`${withMethods[2]!} ${segments.join('')}`);
      }
    }

    return routes.sort();
  }

  it('has not grown a route the matrix has not seen', () => {
    expect(routeTable()).toEqual(
      [
        // Public by design, each one reasoned about where it is declared.
        'GET, HEAD /',
        'GET, HEAD /assets/*',
        // The Station's own logo, at the bundle root rather than under `assets/`.
        //
        // It is here because this inventory did its job: `station.ts` used to serve a
        // hardcoded list of root filenames, `brand-mark.png` was not on it, and the
        // auth hook answered **401** for the Station's logo on every screen in
        // production. Serving the root files by enumeration fixed that and grew the
        // route table — which this test refused to let through silently.
        //
        // Adding a file to `apps/station/public/` will fail this test again, and that
        // is the intended behaviour: a new public route on the service that also holds
        // every sale in the shop should be looked at once by a person.
        'GET, HEAD /brand-mark.png',
        'GET, HEAD /health',
        'GET, HEAD /realtime',
        'OPTIONS *',
        /*
          First run. Public by necessity — nothing can authenticate before the first
          account exists — and safe because `POST` is self-closing: the user count and
          the insert share one transaction, so it refuses from the moment a single
          account exists. `GET` answers a bare boolean that a failed login would have
          revealed anyway.
        */
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/refresh',

        // Open to every authenticated role, deliberately (see auth.routes).
        'GET, HEAD /api/v1/auth/me',
        'POST /api/v1/auth/logout-all',

        // Everything below names its roles, and every one is a row in CASES above.
        // Fastify registers a prefixed plugin's root both with and without the
        // trailing slash, which is why several appear twice.
        'GET, HEAD /api/v1/backup',
        'GET, HEAD /api/v1/backup/',
        'GET, HEAD /api/v1/backup/drive',
        'GET, HEAD /api/v1/backup/drive/',
        'GET, HEAD /api/v1/backup/drive/connect/status',
        'GET, HEAD /api/v1/backup/key',
        'GET, HEAD /api/v1/cards/:id',
        'GET, HEAD /api/v1/customers/:id/card',
        'GET, HEAD /api/v1/customers/:id/cards',
        'GET, HEAD /api/v1/customers/resolve',
        'GET, HEAD /api/v1/customers/search',
        'GET, HEAD /api/v1/discount',
        'GET, HEAD /api/v1/discount/',
        'GET, HEAD /api/v1/flags',
        'GET, HEAD /api/v1/flags/',
        'GET, HEAD /api/v1/reports/overview',
        'GET, HEAD /api/v1/reports/programme',
        // One node, both verbs — Fastify collapses same-path routes in its tree.
        'GET, HEAD /api/v1/system/capture',
        'GET, HEAD, PUT /api/v1/system/printing',
        'GET, HEAD /api/v1/system/storage',
        // Both nodes, as `/discount` and `/flags` also produce: Fastify registers the
        // prefix and the prefix-with-slash as separate entries in its tree.
        'GET, HEAD, POST /api/v1/users',
        'GET, HEAD, POST /api/v1/users/',
        'PATCH /api/v1/users/:id',
        'GET, HEAD /api/v1/vouchers/reconciliation',
        'GET, HEAD, POST /api/v1/auth/bootstrap',
        'GET, HEAD, POST /api/v1/cards/batches',
        'GET, HEAD, PATCH /api/v1/customers/:id',
        'PATCH /api/v1/backup/drive/settings',
        'POST /api/v1/backup/drive/connect',
        'POST /api/v1/backup/drive/disconnect',
        'POST /api/v1/backup/drive/test',
        'POST /api/v1/backup/key/confirm',
        'POST /api/v1/backup/key/generate',
        'POST /api/v1/backup/key/reveal',
        'POST /api/v1/backup/run',
        'POST /api/v1/backup/verify',
        'POST /api/v1/cards/:id/lost',
        'POST /api/v1/cards/:id/replace',
        'POST /api/v1/cards/:id/replace-thermal',
        'POST /api/v1/cards/:id/restore',
        'POST /api/v1/cards/:id/void',
        'POST /api/v1/cards/batches/:id/export',
        'POST /api/v1/cards/batches/:id/void',
        'GET, HEAD, POST /api/v1/customers',
        'GET, HEAD, POST /api/v1/customers/',
        'POST /api/v1/customers/export',
        'POST /api/v1/discount/assess',
        'POST /api/v1/ingest/invoice',
        'POST /api/v1/scan/card',
        'POST /api/v1/scan/identify',
        'POST /api/v1/sync/batch',
        'POST /api/v1/system/client-errors',
        // Registration order, not alphabetical — Fastify lists a node's methods as added.
        'POST, DELETE /api/v1/backup/restore/stage',
        'POST /api/v1/backup/restore/apply',
        'POST /api/v1/vouchers/:id/redeem',
        'POST /api/v1/vouchers/:id/void',
        'PUT /api/v1/discount/rules',
        'PUT /api/v1/discount/settings',
        'PUT /api/v1/flags/:key',
      ].sort(),
    );
  });
});
