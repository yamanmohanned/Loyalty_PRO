import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES } from '@loyalty-pro/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  assertBackupsEnabled,
  assertKeyExists,
  confirmKey,
  ensureKeyGenerated,
  keyStatus,
  revealKey,
} from '../services/backup/key-ceremony.service';
import {
  assertNoBackupRunning,
  listBackups,
  runBackup,
  verifyRestore,
} from '../services/backup/backup.service';
import { recentBackupHistory } from '../services/backup/history.service';
import {
  assertRestoreStaged,
  cancelStagedRestore,
  requestApply,
  restoreStatus,
  stageRestore,
  type RestoreActor,
} from '../services/backup/restore.service';
import { prisma } from '../lib/prisma';
import { scheduleStatus } from '../services/backup/schedule.service';

/**
 * Backup, and the key ceremony that gates it (docs/legacy/CLAUDE_v3.md §7.3, §12.19).
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
 *
 * **A limit counts attempts at the operation, never refusals before it.** The limiter
 * runs in `preHandler` (app.ts), after authentication and validation, and each route's
 * cheap preconditions — no key yet, a backup already running, nothing staged — are its
 * own `preHandler`, which runs before the limiter's. A person who presses a button too
 * early is told why and loses nothing; before, «نسخ احتياطي الآن» pressed six times
 * before the key ceremony locked the real backup out for an hour.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  /** The refusals that mean a backup would not start. */
  const backupCanStart = async (request: FastifyRequest): Promise<void> => {
    const auth = requireDashboardRole(request);
    await assertBackupsEnabled(auth.merchantId);
    assertNoBackupRunning();
  };

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
   *
   * OWNER only, to match `reveal`. A manager who could generate but not reveal would
   * mint a key nobody has ever seen and leave the installation in a state only the owner
   * can resolve — the ceremony is one act and it belongs to one role.
   */
  app.post('/key/generate', { config: { roles: ['OWNER'] } }, async (request) => {
    const auth = requireDashboardRole(request);
    return ensureKeyGenerated(auth.merchantId, auth.sub);
  });

  app.post(
    '/key/reveal',
    {
      // OWNER only, and audited on every call.
      config: { roles: ['OWNER'], rateLimit: { max: 10, timeWindow: '1 hour' } },
      preHandler: async () => assertKeyExists(),
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      return { key: await revealKey(auth.merchantId, auth.sub) };
    },
  );

  /**
   * Confirms the key by re-entry.
   *
   * Open to any dashboard role, unlike generate and reveal: whoever is holding the
   * printed key can complete the ceremony, which is the point of printing it.
   */
  app.post(
    '/key/confirm',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 10, timeWindow: '1 hour' } },
      preHandler: async () => assertKeyExists(),
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
    return { key, destinations, schedule, history, restore: restoreStatus() };
  });

  /**
   * Takes a backup now.
   *
   * Slow by nature — it copies the whole database, encrypts it and pushes it to every
   * destination. The lock already stops two stacking; the limit bounds how many archives
   * an hour can write. Twenty rather than six: «ارفع نسخة الآن» on the Drive panel runs
   * this too, and an owner fixing a Drive setting retries it.
   */
  app.post(
    '/run',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 hour' } },
      preHandler: backupCanStart,
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      return runBackup({ merchantId: auth.merchantId, actorUserId: auth.sub });
    },
  );

  /** The monthly restore test of §7.3, as one call (§12.17). */
  app.post(
    '/verify',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 6, timeWindow: '1 hour' } },
      preHandler: backupCanStart,
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      return verifyRestore({ merchantId: auth.merchantId, actorUserId: auth.sub });
    },
  );

  /* ── Restoring a copy over the shop's data ──────────────────────────────── */

  /*
    OWNER only, all three. Replacing the whole ledger is the most consequential thing
    this program can do, and it signs every other user out.
  */

  /** Step 1: fetch, decrypt and check a copy beside the live database. Replaces nothing. */
  app.post(
    '/restore/stage',
    {
      config: { roles: ['OWNER'], rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        body: z
          .object({
            kind: z.enum(['local', 'usb', 'drive']),
            id: z.string().min(1).max(300),
            // The backup key typed from paper, for a copy made on another machine.
            // `req.body.key` is redacted from the log (app.ts).
            key: z.string().max(200).optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const body = request.body as { kind: string; id: string; key?: string };
      return stageRestore(await restoreActor(auth), { kind: body.kind, id: body.id }, body.key);
    },
  );

  app.delete('/restore/stage', { config: { roles: ['OWNER'] } }, async (request) => {
    requireDashboardRole(request);
    cancelStagedRestore();
    return { staged: null };
  });

  /** Step 2: confirmed. Backs up the present, then restarts to apply at boot. */
  app.post(
    '/restore/apply',
    {
      config: { roles: ['OWNER'], rateLimit: { max: 6, timeWindow: '1 hour' } },
      preHandler: async () => assertRestoreStaged(),
      schema: { body: z.object({ confirm: z.literal(true) }).strict() },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const outcome = await requestApply(await restoreActor(auth));
      reply.status(202);
      return outcome;
    },
  );
}

/** Who is restoring, by name — the result outlives the session that asked for it. */
async function restoreActor(auth: { merchantId: string; sub: string }): Promise<RestoreActor> {
  const user = await prisma.user.findUnique({ where: { id: auth.sub }, select: { name: true } });
  return { merchantId: auth.merchantId, actorUserId: auth.sub, actorName: user?.name ?? null };
}
