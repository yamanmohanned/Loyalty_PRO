import type { FastifyInstance } from 'fastify';
import { DASHBOARD_ROLES } from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import { currentStorageStatus } from '../services/storage.service';

/**
 * Host telemetry the manager needs to act on (CLAUDE_v3.md §12.15).
 *
 * ## Why this is not on `/health`
 *
 * `/health` is public by necessity — a liveness probe carries no token — and free space
 * is not a fact an unauthenticated caller on the shop network is owed. It is a capacity
 * hint about the machine holding every sale this business has recorded, and it is the
 * one number that tells someone how close that machine is to refusing writes. Ordinary
 * least privilege, no drama: it costs nothing to require a session, and `/health` keeps
 * answering the only question a probe should ask.
 *
 * ## Roles
 *
 * Dashboard roles. The Station has no action to take on a low disk — §12.16 already
 * faults its writes at the visible action when storage actually fails — and clearing
 * space is manager work.
 *
 * The realtime channel is per merchant rather than per role, so a connected Station does
 * receive the change event and ignores it today. That asymmetry is deliberate rather than
 * overlooked: warning the till *before* its next scan fails is a plausible future, and
 * the event already being there makes it a Station UI change with no API change.
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The current free-space verdict.
   *
   * Every dashboard client calls this once on connect and then listens for
   * `STORAGE_LEVEL_CHANGED`. The pairing is the point: the event alone would leave a
   * dashboard opened after the transition showing nothing, and polling alone would put
   * the banner up to a minute behind the fact.
   */
  app.get('/storage', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    return currentStorageStatus();
  });
}
