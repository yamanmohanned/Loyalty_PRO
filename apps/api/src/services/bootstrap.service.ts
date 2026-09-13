import type { Prisma } from '@prisma/client';
import { OwnerPasswordSchema } from '@walaa/shared-types';
import { AppError, validationFailed } from '../lib/errors';
import { hashPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIRST RUN — the shop creates its own owner, and nobody ships a password
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The hole this fills ──────────────────────────────────────────────────────
 *
 * The shipped database template is migrated and **empty**: zero merchants, zero
 * branches, zero users. That is the right thing to ship — a template carrying a known
 * account would be a known password on every installation of this product, which is
 * the single worst credential mistake a small product can make.
 *
 * But nothing existed to fill it. A merchant who installed the build met a login screen
 * that no password on earth could open, because there was no account to open it with.
 * The development seed (`prisma/seed.ts`) creates `owner` / `Walaa!Dev2026`, and it is
 * a dev script that is not bundled into the service — so it was covering the gap on
 * every machine except the one that mattered.
 *
 * ── Why the endpoint is public, and why that is safe ─────────────────────────
 *
 * Nobody can authenticate before the first account exists, so the call that creates it
 * cannot require authentication. What makes it safe is that it is **self-closing**: the
 * count and the insert happen in one transaction, and the moment a single user exists
 * this refuses forever. It is not "the first caller wins a race" either — SQLite admits
 * one writer and every write here goes through the same serialising queue, so two
 * simultaneous callers are ordered and the second one loses.
 *
 * The realistic exposure is therefore the minutes between the installer finishing and
 * the shop owner typing his name — on a LAN, behind a firewall rule scoped to private
 * networks, on a machine standing in a back office. The alternative, a shipped
 * credential, is exposed for the life of the installation on every machine at once.
 *
 * ── What it deliberately does not do ─────────────────────────────────────────
 *
 * It creates exactly one merchant, one branch and one OWNER. It does not create a
 * STATION account: the till's account is made from the dashboard afterwards, by
 * somebody who has already proved they are the owner. Bundling it here would mean a
 * second password chosen in the same thirty seconds by someone who has not yet seen the
 * product, and the Station is the account most likely to be written on a sticky note.
 */

/*
  The password rule is not defined here any more.

  It used to be: the length floor lived in `BootstrapRequestSchema` and the deny-list
  lived in this file, so a password the setup form was willing to send could still be
  refused on arrival — and the merchant got «البيانات المرسلة غير صحيحة» after typing
  it twice. One rule, one definition, in the package both sides import.

  It is still asserted HERE as well as at the route, because a rule this cheap should
  hold for any caller that never went near the route.
*/

export interface BootstrapInput {
  merchantName: string;
  branchName: string;
  branchCode: string;
  ownerName: string;
  username: string;
  password: string;
}

/** Whether this installation still has no account at all. */
export async function bootstrapRequired(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/**
 * Creates the shop and its owner, once.
 *
 * Every check that decides whether this is allowed happens **inside** the transaction
 * that does the writing. Counting outside it and inserting after would be the
 * read-then-write shape that the voucher redemption drill demonstrates failing: two
 * callers both read zero, both insert, and the installation ends up with two owners
 * where the whole guarantee was that it has one.
 */
export async function bootstrapInstallation(
  input: BootstrapInput,
  meta: { ip: string },
): Promise<{ merchantId: string; branchId: string; userId: string }> {
  const password = input.password;

  const acceptable = OwnerPasswordSchema.safeParse(password);
  if (!acceptable.success) {
    const first = acceptable.error.issues[0];
    throw validationFailed(first?.message ?? 'كلمة المرور غير صالحة', [
      { path: 'password', message: first?.message ?? 'كلمة المرور غير صالحة' },
    ]);
  }

  // Hashed before the transaction opens: Argon2id is deliberately slow, and holding
  // the single writer for the length of a hash would stall every other write behind it.
  const passwordHash = await hashPassword(password);

  return writeTransaction(async (db: Prisma.TransactionClient) => {
    if ((await db.user.count()) > 0) {
      /*
        `FORBIDDEN` rather than a new error code. The shared `ApiErrorCode` enum is a
        contract every client compiles against, and "you may not do this" is exactly
        what a 403 means — adding a fourteenth code to say it more precisely would
        widen a shared type for one caller's benefit.
      */
      throw new AppError(
        'FORBIDDEN',
        // The second clause promised a recovery that does not exist: there is no owner
        // password reset in this product, by design, and support has no tool for one. A
        // sentence that sends somebody to support for something support cannot do is the
        // defect this pass is about.
        'تم إعداد هذا التثبيت مسبقاً — سجّل الدخول بحساب المالك من شاشة الدخول.',
      );
    }

    const merchant = await db.merchant.create({
      data: { name: input.merchantName.trim() },
      select: { id: true },
    });

    const branch = await db.branch.create({
      data: {
        merchantId: merchant.id,
        name: input.branchName.trim(),
        code: input.branchCode.trim().toUpperCase(),
      },
      select: { id: true },
    });

    const user = await db.user.create({
      data: {
        merchantId: merchant.id,
        // Null, because an OWNER is not bound to one branch (§13.9: branch is a
        // verified property of the writer, and the owner may write anywhere).
        branchId: null,
        name: input.ownerName.trim(),
        username: input.username.trim().toLowerCase(),
        passwordHash,
        role: 'OWNER',
      },
      select: { id: true },
    });

    /*
      ── The shop's discount settings, in the SAME transaction ─────────────────

      Without this row the first sale of the installation fails. `scanCard` reads it
      with `findUniqueOrThrow`, so a merchant who installed, set up, registered a
      customer and scanned their card met a 500 rendered at the till as «لم تُحفظ
      العملية … أبلغ الإدارة فوراً» — the most alarming message in the product, on
      install day, for a missing configuration row with perfectly good defaults.

      Nothing outside `prisma/seed.ts` had ever created it, and that is a development
      script which is not bundled into the service. The third thing found this way,
      after the missing first-run flow and the missing staff accounts, and all three
      are the same defect: the seed was standing in for a step the product does not
      have.

      Created here rather than only on demand because a bootstrapped installation
      should BE a complete shop, not one that assembles itself on first use. The
      schema's defaults apply — percentage discounts bounded 1–3% and capped at 5,000
      IQD — and with **no rules configured no discount is ever given**, so the shop can
      trade immediately without giving anything away before the merchant has agreed a
      ladder. `discount-settings.service.ts` covers installations made by earlier
      builds, which have no row and never will.
    */
    await db.discountSettings.create({ data: { merchantId: merchant.id } });

    /*
      Audited like every other privileged act, and this one has no actor to name — the
      account being created IS the first actor. Recording it against the new owner is
      the honest answer: it is the row that says when this installation came into
      existence and from where.
    */
    await recordAudit(
      {
        merchantId: merchant.id,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.INSTALLATION_BOOTSTRAPPED,
        entityType: 'merchant',
        entityId: merchant.id,
        before: null,
        after: {
          merchantName: input.merchantName.trim(),
          branchCode: input.branchCode.trim().toUpperCase(),
          ownerUsername: input.username.trim().toLowerCase(),
          fromIp: meta.ip,
        },
      },
      db,
    );

    return { merchantId: merchant.id, branchId: branch.id, userId: user.id };
  });
}
