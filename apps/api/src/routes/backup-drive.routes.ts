import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES, DriveClientUpdateSchema, type DriveClientUpdate } from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  beginConnect,
  connectProgress,
  disconnect,
} from '../services/backup/drive-connect.service';
import {
  clearDriveClient,
  driveStatus,
  saveDriveClient,
  testDriveConnection,
  updateDriveSettings,
} from '../services/backup/drive-status.service';
import { DriveError } from '../services/backup/drive-errors';
import { AppError } from '../lib/errors';

/**
 * The Google Drive destination's own surface (CLAUDE_v3.md §7.3).
 *
 * Separate from `backup.routes.ts` deliberately. Everything under `/backup` is about the
 * backup itself — the key, the run, the restore test — and every one of those must keep
 * working with Drive absent, misconfigured or broken. Keeping the Drive endpoints in
 * their own file makes that boundary visible rather than a matter of care.
 *
 * ## Roles
 *
 * Reading is manager-or-owner. **Connecting and disconnecting are OWNER only**, matching
 * the key-reveal rule and for the same reason: connecting binds a personal Google
 * account to this installation and creates a standing credential that carries the shop's
 * data off the machine. A shop may have several managers over the years; the set of
 * people who may hand out that access is smaller than the set who may press "back up
 * now".
 *
 * Changing retention or pausing uploads is manager-or-owner — it alters how many copies
 * exist, not who can reach them.
 *
 * ## Rate limits
 *
 * `connect` opens a loopback listener and `disconnect` calls Google. Neither is invoked
 * more than a handful of times in the life of an installation, so a tight limit costs
 * nothing real and stops a stuck client from opening a listener every second.
 */
export async function backupDriveRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the Settings panel needs.
   *
   * `probe=false` skips the live call to Drive, for a caller that wants the stored state
   * without waiting on the network.
   */
  app.get(
    '/',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        querystring: z
          .object({ probe: z.enum(['true', 'false']).optional() })
          .strict(),
      },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { probe } = request.query as { probe?: 'true' | 'false' };
      return driveStatus(auth.merchantId, { probe: probe !== 'false' });
    },
  );

  /**
   * Starts the consent flow and returns the URL to open in a browser.
   *
   * The response carries a URL and nothing else — no token, no secret, no code. The
   * credential this flow produces never enters an HTTP response body at all; it is
   * minted inside the service and written to disk encrypted (§7.6).
   */
  app.post(
    '/connect',
    { config: { roles: ['OWNER'], rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request) => {
      const auth = requireDashboardRole(request);
      try {
        return await beginConnect({ merchantId: auth.merchantId, actorUserId: auth.sub });
      } catch (error) {
        throw asAppError(error);
      }
    },
  );

  /** Where the pending consent has got to. Polled while the browser tab is open. */
  app.get('/connect/status', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    return connectProgress();
  });

  app.post(
    '/disconnect',
    { config: { roles: ['OWNER'], rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request) => {
      const auth = requireDashboardRole(request);
      await disconnect({ merchantId: auth.merchantId, actorUserId: auth.sub });
      return driveStatus(auth.merchantId, { probe: false });
    },
  );

  /**
   * Retention and the pause switch.
   *
   * The upper bound on `keep` is not arbitrary: retention is what a merchant reaches for
   * when Drive reports "full", and an unbounded value would let the panel's own remedy
   * make the problem permanent.
   */
  app.patch(
    '/settings',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        body: z
          .object({
            enabled: z.boolean().optional(),
            keep: z.number().int().min(1).max(365).optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const change = request.body as { enabled?: boolean; keep?: number };
      return updateDriveSettings(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        change,
      );
    },
  );

  /**
   * «اختبار الاتصال»: authorise, upload a small file, read it back, delete it.
   *
   * It was the status probe — a list call — which passes on a full Drive and on a
   * folder the app cannot write, the two cases in which the nightly upload fails. Each
   * step now reports for itself, so a merchant who has just fixed something gets an
   * answer on demand instead of waiting for 23:30 to find out.
   */
  app.post(
    '/test',
    { config: { roles: DASHBOARD_ROLES, rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request) => {
      requireDashboardRole(request);
      return testDriveConnection();
    },
  );

  /**
   * The OAuth client — typed into Settings by the owner, the secret stored encrypted.
   *
   * OWNER only, like connecting: this is what lets the installation ask Google for
   * access at all. `req.body.clientSecret` is redacted from the log (app.ts), and the
   * response carries the id only.
   */
  app.put(
    '/client',
    {
      config: { roles: ['OWNER'], rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: { body: DriveClientUpdateSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      return saveDriveClient(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as DriveClientUpdate,
      );
    },
  );

  app.delete('/client', { config: { roles: ['OWNER'] } }, async (request) => {
    const auth = requireDashboardRole(request);
    return clearDriveClient({ merchantId: auth.merchantId, actorUserId: auth.sub });
  });
}

/**
 * A DriveError as the shared error envelope.
 *
 * The Arabic sentence travels; `detail` does not. It carries HTTP statuses and Google
 * error codes, which belong in the service log and never on a merchant's screen (§7.6).
 */
function asAppError(error: unknown): unknown {
  if (error instanceof DriveError) {
    return new AppError('VALIDATION_FAILED', error.message, { cause: error });
  }
  return error;
}
