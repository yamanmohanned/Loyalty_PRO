import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { loadEnv } from '../../config/env';
import type {
  NotificationMessage,
  NotificationProvider,
  NotificationResult,
  NotificationTemplate,
  TemplateVariables,
} from './provider';

export * from './provider';

type Db = PrismaClient | Prisma.TransactionClient;

const env = loadEnv();

/**
 * Development provider: logs instead of sending (CLAUDE.md §3.5).
 *
 * Returns STUBBED rather than SENT so `notification_log` never claims a message
 * reached a customer when it did not. A developer reading the table months later
 * must be able to tell the difference.
 */
export const stubProvider: NotificationProvider = {
  id: 'stub',
  async send(message: NotificationMessage): Promise<NotificationResult> {
    // eslint-disable-next-line no-console -- printing is precisely what the stub provider is for
    console.info(
      `[notification:stub] template=${message.template} to=${maskPhone(message.to)} ` +
        `vars=${JSON.stringify(message.variables)}`,
    );
    return { status: 'STUBBED' };
  },
};

/** Logs never carry a full phone number (CLAUDE.md §7.11). */
function maskPhone(phone: string): string {
  return phone.length <= 4 ? '***' : `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

/**
 * Selects the configured provider. The WhatsApp Cloud API implementation lands in
 * Phase 4; until then a `whatsapp` configuration falls back to the stub loudly
 * rather than silently dropping messages.
 */
export function getNotificationProvider(): NotificationProvider {
  if (env.NOTIFICATION_PROVIDER === 'whatsapp') {
    console.warn(
      '[notification] NOTIFICATION_PROVIDER=whatsapp but the Cloud API provider ships in ' +
        'Phase 4 — falling back to the stub. No messages will reach customers.',
    );
  }
  return stubProvider;
}

/**
 * Enqueues a notification by writing a PENDING row.
 *
 * **WhatsApp is optional in v3** (§8). Nothing in the core loop depends on
 * messaging: the customer holds a printed card and receives a printed slip. This
 * runs only when the `whatsapp_integration` flag is on.
 *
 * **Tradeoff (CLAUDE.md §3.2):** this is a database-backed queue rather than
 * BullMQ + Redis. Reasons: it needs no extra infrastructure, and — the part that
 * matters — the enqueue can join the same database transaction as the link it
 * belongs to, so a committed transaction can never be missing its notification.
 * The cost is that delivery needs a poller rather than a blocking pop, which at a
 * single supermarket's message volume is not a real cost. Revisit if this becomes
 * multi-merchant with meaningful throughput.
 */
export async function enqueueNotification(
  params: {
    merchantId: string;
    customerId: string;
    template: NotificationTemplate;
    variables: TemplateVariables;
  },
  db: Db = prisma,
): Promise<void> {
  await db.notificationLog.create({
    data: {
      merchantId: params.merchantId,
      customerId: params.customerId,
      channel: 'WHATSAPP',
      template: params.template,
      // Template variables only — never a token, never a credential. Serialized
      // because SQLite has no Json column type.
      payload: JSON.stringify(params.variables),
      status: 'PENDING',
    },
  });
}
