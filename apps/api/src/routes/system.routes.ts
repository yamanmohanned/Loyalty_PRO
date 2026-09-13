import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DASHBOARD_ROLES,
  PaperWidthSchema,
  type CaptureStatus,
  type PaperWidth,
} from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import { AUDIT_ACTIONS, recordAudit } from '../services/audit.service';
import { prisma } from '../lib/prisma';
import { currentStorageStatus } from '../services/storage.service';
import { buildDemoShop, isDemoBuild } from '../services/demo.service';

const UpdatePrintingRequestSchema = z.object({ paperWidth: PaperWidthSchema }).strict();

const ClientErrorReportSchema = z
  .object({
    screen: z.string().trim().min(1).max(80),
    message: z.string().max(500),
    stack: z.string().max(4000).optional(),
  })
  .strict();

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

  /**
   * A dashboard screen that crashed while drawing, reported into this service's log.
   *
   * The dashboard's console is a place nobody will ever look on a shop PC; this log is
   * the one file support can be sent. The response is the request id, which the screen
   * shows as «الرقم المرجعي» and which is the `reqId` on the log line — so "the Cards
   * screen shows 3f9a1c2b" finds the stack in one search.
   *
   * Bounded and rate-limited: a render loop must not be able to fill the disk this
   * product spends so much effort protecting.
   */
  app.post(
    '/client-errors',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: ClientErrorReportSchema },
    },
    async (request) => {
      requireDashboardRole(request);
      const report = request.body as z.infer<typeof ClientErrorReportSchema>;
      request.log.error({ clientError: report }, 'dashboard screen failed to render');
      return { reference: request.id };
    },
  );

  /**
   * The Loyalty Station's thermal roll width (§5).
   *
   * Merchant-level, not per-station (§10.7). Dashboard roles only: the Station has no
   * settings screen by design (§6.4), and which roll is loaded is a manager's fact
   * about the shop rather than an operator's about their shift.
   *
   * Audited, because it changes what comes out of a printer and "why did the slips
   * start printing narrow" is a question somebody asks a week later.
   */
  /**
   * Whether captured invoices are reaching this machine — measured, not assumed.
   *
   * Replaces a constant on the Capture screen that said the agent was "not installed
   * yet, built in a later phase" on every installation, whatever was happening. The
   * question a manager actually has is whether sales are arriving, and the answer is in
   * the captures themselves.
   */
  app.get('/capture', { config: { roles: DASHBOARD_ROLES } }, async (request): Promise<CaptureStatus> => {
    const auth = requireDashboardRole(request);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [last, recent] = await Promise.all([
      prisma.transaction.findFirst({
        where: { merchantId: auth.merchantId },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      }),
      prisma.transaction.count({
        where: { merchantId: auth.merchantId, capturedAt: { gte: since } },
      }),
    ]);
    return {
      lastCapturedAt: last?.capturedAt.toISOString() ?? null,
      capturedLast24h: recent,
    };
  });

  app.get('/printing', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: auth.merchantId },
      select: { paperWidth: true },
    });
    return { paperWidth: merchant.paperWidth as PaperWidth };
  });

  app.put(
    '/printing',
    { config: { roles: DASHBOARD_ROLES }, schema: { body: UpdatePrintingRequestSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { paperWidth } = request.body as { paperWidth: PaperWidth };

      const before = await prisma.merchant.findUniqueOrThrow({
        where: { id: auth.merchantId },
        select: { paperWidth: true },
      });

      const updated = await prisma.merchant.update({
        where: { id: auth.merchantId },
        data: { paperWidth },
        select: { paperWidth: true },
      });

      await recordAudit({
        merchantId: auth.merchantId,
        actorUserId: auth.sub,
        action: AUDIT_ACTIONS.PAPER_WIDTH_UPDATED,
        entityType: 'merchant',
        entityId: auth.merchantId,
        before: { paperWidth: before.paperWidth },
        after: { paperWidth: updated.paperWidth },
      });

      return { paperWidth: updated.paperWidth as PaperWidth };
    },
  );
  /*
    ── The demo reset ────────────────────────────────────────────────────────

    **Registered only in a demo build.** `isDemoBuild()` reads `WALAA_DEMO`, which the
    demo launcher sets and a production install never does, so in a real deployment
    this route does not exist — a request to it 404s the same as any unknown path,
    rather than existing and refusing. An endpoint that can erase a shop's history is
    not one to leave present-but-guarded when it can be absent.

    `buildDemoShop` gates itself again on the open database file (§`assertDemoDatabase`),
    so even a production install started with the flag set by mistake cannot wipe
    `walaa.db`.

    OWNER only, and slow: roughly half a minute to replay six months through the real
    services. The client says so before it starts, because a button that appears to
    hang is worse than one that warns.
  */
  if (isDemoBuild()) {
    app.post('/demo/reset', { config: { roles: ['OWNER', 'MANAGER'] } }, async (request) => {
      requireDashboardRole(request);
      const result = await buildDemoShop((line) => request.log.info({ demo: line }, 'demo reset'));
      await recordAudit({
        merchantId: request.auth!.merchantId,
        actorUserId: request.auth!.sub,
        action: AUDIT_ACTIONS.DEMO_RESET,
        entityType: 'merchant',
        entityId: request.auth!.merchantId,
        before: null,
        after: result,
      });
      return result;
    });
  }

}
