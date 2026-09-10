import type { DiscountSettings } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SHOP ALWAYS HAS DISCOUNT SETTINGS, OR ITS FIRST SALE FAILS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The blocker this closes ──────────────────────────────────────────────────
 *
 * Three surfaces read `discount_settings` and every one of them assumed the row was
 * there: `scanCard` with `findUniqueOrThrow`, the Discounts screen with a 404, and
 * voucher settlement. Nothing on a merchant's machine ever created it.
 *
 * `bootstrapInstallation` creates a merchant, a branch and an owner. `prisma/seed.ts`
 * creates the settings — and it is a development script that is not bundled into the
 * service, so it was covering the gap on every machine except the one that mattered.
 * The third instance of that exact shape, after the missing first-run flow and the
 * missing staff accounts.
 *
 * What it produced, walking a merchant's first sixty seconds: install, set up, create
 * the till account, register a customer, capture a real invoice, scan the card — and
 * the Station answered
 *
 *   «لم تُحفظ العملية. وصل الطلب إلى الخادم ولم يُسجَّل … أبلغ الإدارة فوراً»
 *
 * on the very first sale, from a P2025 behind a 500. The most alarming message in the
 * product, on install day, in front of the shop owner, for a missing configuration row
 * with perfectly good defaults.
 *
 * ── Why this self-heals rather than only being created at bootstrap ──────────
 *
 * It IS created at bootstrap now, which is the real fix. This exists as well because:
 *
 *   · an installation made by an earlier build has no row and would hit the same 500;
 *   · the row is pure configuration with defined defaults, so creating it loses
 *     nothing and invents nothing — unlike a missing customer or a missing sale,
 *     whose absence is information;
 *   · the alternative on that path is a five-hundred at the till, and «the till
 *     could not record a sale» is the one failure this product may not have.
 *
 * The defaults are the schema's own: percentage discounts, bounded 1–3%, capped at
 * 5,000 IQD. **With no rules configured no discount is ever given** — the ladder
 * decides, and a new shop has an empty one — so this makes a shop able to trade
 * without giving anything away before the merchant has agreed to it.
 */
export async function ensureDiscountSettings(merchantId: string): Promise<DiscountSettings> {
  const existing = await prisma.discountSettings.findUnique({ where: { merchantId } });
  if (existing) return existing;

  /*
    `upsert` rather than `create`, on the unique `merchantId`. Two callers arriving
    together — the till scanning while the manager opens the Discounts screen — would
    both read `null` and both insert, and the second would fail on the constraint. This
    is the one write in the product that is safe to race, because both writers want the
    identical row.
  */
  return prisma.discountSettings.upsert({
    where: { merchantId },
    update: {},
    create: { merchantId },
  });
}
