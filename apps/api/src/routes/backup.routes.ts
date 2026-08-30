import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES } from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  confirmKey,
  ensureKeyGenerated,
  keyStatus,
  revealKey,
} from '../services/backup/key-ceremony.service';
import { listBackups, runBackup, verifyRestore } from '../services/backup/backup.service';
import { recentBackupHistory } from '../services/backup/history.service';
import { scheduleStatus } from '../services/backup/schedule.service';

/**
 * Backup, and the key ceremony that gates it (CLAUDE_v3.md §7.3, §12.19).
 *
 * ## Roles
 *
 * Everything here is manager-or-owner; the Station never touches it. **Revealing the key
 * is OWNER only.** A shop may have several managers over the years, and the set of people
 * who should be able to display the one secret that makes every archive readable is
 * smaller than the set who should be able to press "back up now".
 *
 * ## Rate limits
 *
 * The reveal and confirm endpoints are limited hard. Confirm compares a submitted key
 * against the real one, so an unlimited endpoint is an oracle; reveal hands out the
 * secret itself. Neither is called more than a handful of times in the life of an
 * installation, so a tight limit costs nothing real.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  /* ── The ceremony ───────────────────────────────────────────────────────── */

  app.get('/key', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return keyStatus(auth.merchantId);
  });

  /**
   * Starts the ceremony: generates a key if there is none.
   *
   * Idempotent, and deliberately incapable of replacing an existing key — that would
   * orphan every archive already taken. Rotation, if it is ever wanted, is a different
   * endpoint with different warnings.
   */
  app.post('/key/generate', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return ensureKeyGenerated(auth.merchantId, auth.sub);
  });

  app.post(
    '/key/reveal',
    {
      // OWNER only, and audited on every call.
      config: { roles: ['OWNER'], rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      return { key: await revealKey(auth.merchantId, auth.sub) };
    },
  );

  app.post(
    '/key/confirm',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        body: z
          .object({
            // Base64 of 32 bytes. Length is bounded so a hostile body cannot be used to
            // push work into the constant-time comparison.
            key: z.string().trim().min(1).max(128),
          })
          .strict(),
      },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { key } = request.body as { key: string };

      // A mismatch surfaces as VALIDATION_FAILED through the shared envelope — the
      // manager mistyped, which is the expected outcome of asking someone to copy 44
      // characters off a piece of paper.
      return confirmKey(auth.merchantId, auth.sub, key);
    },
  );

  /* ── Backups ────────────────────────────────────────────────────────────── */

  /**
   * Everything the Backup screen needs, in one call.
   *
   * One request rather than four because a manager opening this screen is usually asking
   * a single question — "is this working" — and answering it from four independently
   * loading panels invites reading a green tick beside a stale number.
   */
  app.get('/', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    const [key, destinations, schedule, history] = await Promise.all([
      keyStatus(auth.merchantId),
      listBackups(),
      scheduleStatus(auth.merchantId),
      recentBackupHistory(auth.merchantId),
    ]);
    return { key, destinations, schedule, history };
  });

  /**
   * Takes a backup now.
   *
   * Slow by nature — it copies the whole database, encrypts it and pushes it to every
   * destination — so the rate limit is about not stacking them, not about abuse.
   */
  app.post(
    '/run',
    { config: { roles: DASHBOARD_ROLES, rateLimit: { max: 6, timeWindow: '1 hour' } } },
    async (request) => {
      const auth = requireDashboardRole(request);
      return runBackup({ merchantId: auth.merchantId, actorUserId: auth.sub });
    },
  );

  /** The monthly restore test of §7.3, as one call (§12.17). */
  app.post(
    '/verify',
    { config: { roles: DASHBOARD_ROLES, rateLimit: { max: 6, timeWindow: '1 hour' } } },
    async (request) => {
      const auth = requireDashboardRole(request);
      return verifyRestore({ merchantId: auth.merchantId, actorUserId: auth.sub });
    },
  );
}
