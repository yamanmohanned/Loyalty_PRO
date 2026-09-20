import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DASHBOARD_ROLES,
  SETTING_DEFINITIONS,
  SETTING_GROUPS,
  SETTING_GROUP_LABELS_AR,
  SETTINGS_BY_KEY,
  STATION_ROLES,
  WRITABLE_SETTING_SCOPES,
} from '@loyalty-pro/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import {
  SettingsError,
  discardDraft,
  effectiveSettings,
  listVersions,
  publishDraft,
  rollbackTo,
  saveDraft,
  settingsView,
} from '../services/settings.service';

/**
 * The settings engine's HTTP surface (PRD §4, FND-04).
 *
 * ── Who may read, and why the Station may ────────────────────────────────────
 *
 * Reading the EFFECTIVE values is open to the Station, because several of them govern
 * what the Station does — how long the card stays on screen, when the receipt fades,
 * when the screen resets itself. Reading the REGISTRY, the drafts and the version
 * history is dashboard-only: §3 puts every setting behind the manager and none in front
 * of the operator, and the registry is the shape of the settings screen, which the
 * operator has no business rendering.
 *
 * Writing is dashboard-only and then narrowed again per setting by `editableBy`, which
 * is checked here rather than trusted to the screen. A MANAGER may lengthen the card
 * display; only an OWNER may change the timezone or the lockout policy.
 */

const ScopeQuerySchema = z
  .object({
    scope: z.enum(WRITABLE_SETTING_SCOPES).default('MERCHANT'),
    /** The station id, and required when the scope is STATION. */
    scopeId: z.string().uuid().optional(),
  })
  .strict()
  .refine((q) => q.scope !== 'STATION' || !!q.scopeId, {
    message: 'إعدادات المحطة تحتاج معرّف المحطة',
    path: ['scopeId'],
  });

const ValuesSchema = z.record(z.union([z.number(), z.boolean(), z.string(), z.null()]));

/**
 * The roles allowed to change every key in a payload.
 *
 * Checked on the server for the ordinary reason: the screen hides what a MANAGER may
 * not edit, and a hidden field is not an absent one. An unknown key is left alone here
 * and refused by the service's validation, so that the reply says «إعداد غير معروف»
 * rather than «ليست لديك صلاحية», which is the difference between a stale client and a
 * permissions problem.
 */
function keysBeyondRole(values: Record<string, unknown>, role: string): string[] {
  return Object.keys(values).filter((key) => {
    const definition = SETTINGS_BY_KEY[key];
    if (!definition) return false;
    return !(definition.editableBy as readonly string[]).includes(role);
  });
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The registry: every setting with its kind, bounds, default and Arabic wording.
   *
   * The manager's settings screens are generated from this, which is what stops the
   * bound a field enforces from drifting away from the bound the API enforces — there
   * is one set of numbers and both sides read it.
   */
  app.get('/registry', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return {
      groups: SETTING_GROUPS.map((group) => ({
        key: group,
        labelAr: SETTING_GROUP_LABELS_AR[group],
      })),
      settings: SETTING_DEFINITIONS.map((definition) => ({
        ...definition,
        /** Pre-computed so a screen can disable a field rather than fail on submit. */
        editable: (definition.editableBy as readonly string[]).includes(auth.role),
      })),
    };
  });

  /**
   * The values in force. Open to the Station, which reads its own layer.
   *
   * A station asks with its own id and gets merchant settings with its overrides on
   * top; anything else gets the merchant-wide answer.
   */
  app.get(
    '/effective',
    {
      config: { roles: STATION_ROLES },
      schema: { querystring: z.object({ stationId: z.string().uuid().optional() }).strict() },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { stationId } = request.query as { stationId?: string };
      return { settings: await effectiveSettings(auth.merchantId, stationId ?? null) };
    },
  );

  /** One layer's editing screen: effective values, the draft, and whether it differs. */
  app.get(
    '/',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: ScopeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      return settingsView(auth.merchantId, { scope, scopeId });
    },
  );

  /**
   * Writes to the draft. Nothing published changes, so nothing a shop is running
   * changes — which is what lets a manager edit during trading hours.
   *
   * Replies 200 with the rejections rather than 4xx when only some values failed: the
   * accepted ones were saved, and a status code cannot say "six of seven".
   */
  app.patch(
    '/draft',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: { querystring: ScopeQuerySchema, body: z.object({ values: ValuesSchema }).strict() },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      const { values } = request.body as { values: Record<string, unknown> };

      const beyond = keysBeyondRole(values, auth.role);
      if (beyond.length > 0) {
        return reply.code(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'بعض هذه الإعدادات يغيّرها المالك فقط.',
            details: { keys: beyond },
          },
        });
      }

      return saveDraft(auth.merchantId, { scope, scopeId }, values, auth.sub);
    },
  );

  /** Throws the draft away. The published values were never touched by it. */
  app.delete(
    '/draft',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: ScopeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      await discardDraft(auth.merchantId, { scope, scopeId });
      return { discarded: true };
    },
  );

  /** Promotes the draft: the one act that changes what the shop is running. */
  app.post(
    '/publish',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        querystring: ScopeQuerySchema,
        body: z.object({ note: z.string().max(200).optional() }).strict(),
      },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      const { note } = request.body as { note?: string };

      try {
        return await publishDraft(auth.merchantId, { scope, scopeId }, auth.sub, note);
      } catch (error) {
        if (error instanceof SettingsError) {
          return reply.code(409).send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );

  /** Newest first. What a manager scans after something starts behaving differently. */
  app.get(
    '/versions',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: ScopeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      return { versions: await listVersions(auth.merchantId, { scope, scopeId }) };
    },
  );

  /**
   * Restores an earlier version — by publishing it again as the newest, never by
   * deleting what came after.
   *
   * OWNER-only although publishing is not. A rollback silently reverses decisions a
   * manager may have made since, and the person who should own an undo of that size is
   * the person who owns the shop.
   *
   * Declared in `config.roles`, not checked inside the handler. Schema validation runs
   * BEFORE the handler, so an in-handler check answers a manager with 400 when his body
   * is malformed and 403 only when it is well-formed — a refusal that depends on the
   * shape of the request is not a refusal. The role gate belongs where every other one
   * in this service lives, in front of everything.
   */
  app.post(
    '/rollback',
    {
      config: { roles: ['OWNER'] },
      schema: {
        querystring: ScopeQuerySchema,
        body: z.object({ version: z.number().int().positive() }).strict(),
      },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { scope, scopeId } = request.query as { scope: 'MERCHANT' | 'STATION'; scopeId?: string };
      const { version } = request.body as { version: number };

      try {
        return await rollbackTo(auth.merchantId, { scope, scopeId }, version, auth.sub);
      } catch (error) {
        if (error instanceof SettingsError) {
          return reply.code(404).send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );
}
