import type { Prisma } from '@prisma/client';
import type { CreateUserRequest, StaffListResponse, UpdateUserRequest } from '@walaa/shared-types';
import { AppError, notFound, validationFailed } from '../lib/errors';
import { hashPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAFF ACCOUNTS — THE ONES THE PRODUCT COULD NOT CREATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The blocker this closes ──────────────────────────────────────────────────
 *
 * `bootstrapInstallation` creates exactly one OWNER and documents why it stops there:
 * the till's account belongs to somebody who has already proved they own the shop, and
 * asking for two passwords in the first thirty seconds is how the second one ends up
 * on a sticky note. Correct — and the screen it deferred to was never built.
 *
 * Walking a merchant's first sixty seconds on a machine with no prior state is what
 * surfaced it. Install, set up, sign in, dashboard — and then nothing, because the
 * **Loyalty Station can never be signed into**. The Station is where the whole core
 * loop lives. The product could be installed and configured and could not do the thing
 * it exists to do.
 *
 * The only `station` account that has ever existed is in `prisma/seed.ts`, a
 * development script that is not bundled into the service. It was covering the gap on
 * every machine except a merchant's — the same shape as the missing first-run flow,
 * found the same way.
 *
 * ── What this deliberately will not do ───────────────────────────────────────
 *
 * - **It cannot create an OWNER.** There is exactly one, made at first run, and a
 *   second one would be a second unrecoverable password with full reach. `StaffRole`
 *   is `MANAGER | STATION` in the shared schema, so the API cannot be asked for one.
 * - **It cannot delete anybody.** A user is deactivated. `audit_log`,
 *   `transaction.linkedByUserId` and `voucher.redeemedByUserId` all point at these
 *   rows, and deleting one would either cascade a shop's history away or leave the
 *   trail naming an id nobody can resolve.
 * - **It cannot touch the OWNER's own account**, including its password. The owner's
 *   password is the one with no reset by design, and a route that could set it would be
 *   a reset — reachable by anybody holding an owner session, which is the session an
 *   attacker would already have.
 */

/** Which accounts an OWNER may create or change. Never OWNER. */
const MANAGEABLE_ROLES = new Set(['MANAGER', 'STATION']);

export async function listStaff(merchantId: string): Promise<StaffListResponse> {
  const [users, branches] = await Promise.all([
    prisma.user.findMany({
      where: { merchantId },
      orderBy: [{ role: 'asc' }, { username: 'asc' }],
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        isActive: true,
        branchId: true,
        createdAt: true,
        branch: { select: { code: true } },
      },
    }),
    prisma.branch.findMany({
      where: { merchantId, isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true, name: true, code: true },
    }),
  ]);

  return {
    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role as StaffListResponse['users'][number]['role'],
      isActive: user.isActive,
      branchId: user.branchId,
      branchCode: user.branch?.code ?? null,
      createdAt: user.createdAt.toISOString(),
    })),
    branches,
  };
}

export async function createStaffUser(
  input: CreateUserRequest,
  actor: { merchantId: string; userId: string },
): Promise<{ id: string }> {
  const username = input.username.trim().toLowerCase();

  /*
    A STATION must name its branch. §13.9 verifies rather than trusts the branch on
    every captured invoice — a bound user must match the branch the sale claims — and an
    unbound till would either be refused on every scan or, worse, allowed to attribute a
    sale to any branch in the shop. Refused here, with the field named, rather than
    discovered at the counter.
  */
  if (input.role === 'STATION' && !input.branchId) {
    throw validationFailed(undefined, [
      { path: 'branchId', message: 'حساب المحطة يجب أن يرتبط بفرع' },
    ]);
  }

  return writeTransaction(async (db: Prisma.TransactionClient) => {
    /*
      Checked inside the transaction that does the writing, not before it. SQLite admits
      one writer and every write here goes through the same serialising queue, so two
      simultaneous creates of the same username are ordered and the second one loses —
      rather than both reading "free" and both inserting.
    */
    const taken = await db.user.findFirst({
      where: { merchantId: actor.merchantId, username },
      select: { id: true },
    });
    if (taken) {
      throw validationFailed(undefined, [
        { path: 'username', message: 'اسم الدخول مستخدم بالفعل — اختر غيره' },
      ]);
    }

    if (input.branchId) {
      const branch = await db.branch.findFirst({
        where: { id: input.branchId, merchantId: actor.merchantId },
        select: { id: true },
      });
      // Scoped by merchant, not looked up globally: a branch id from another
      // installation must not resolve here (§2.5).
      if (!branch) {
        throw validationFailed(undefined, [{ path: 'branchId', message: 'الفرع غير موجود' }]);
      }
    }

    const created = await db.user.create({
      data: {
        merchantId: actor.merchantId,
        branchId: input.branchId ?? null,
        name: input.name.trim(),
        username,
        // Hashed inside the transaction is a real cost — Argon2id is deliberately slow
        // and this holds the single writer — but creating a staff account is a
        // once-a-year act by one person, and hashing outside would mean hashing a
        // password for a username that turns out to be taken.
        passwordHash: await hashPassword(input.password),
        role: input.role,
      },
      select: { id: true },
    });

    await recordAudit(
      {
        merchantId: actor.merchantId,
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: 'user',
        entityId: created.id,
        before: null,
        // The hash is not in here, and neither is the password. An append-only trail
        // that carries a credential is a credential store nobody remembers writing.
        after: { username, role: input.role, branchId: input.branchId ?? null },
      },
      db,
    );

    return { id: created.id };
  });
}

export async function updateStaffUser(
  id: string,
  input: UpdateUserRequest,
  actor: { merchantId: string; userId: string },
): Promise<void> {
  await writeTransaction(async (db: Prisma.TransactionClient) => {
    const existing = await db.user.findFirst({
      where: { id, merchantId: actor.merchantId },
      select: { id: true, role: true, name: true, isActive: true, branchId: true, username: true },
    });
    if (!existing) throw notFound('الحساب غير موجود');

    /*
      The OWNER is out of reach from here, and that is a security property rather than
      a tidy rule. This endpoint can set a password; if it could set the OWNER's, it
      would be a password reset for the account with no reset — reachable by anybody
      holding an owner session, which is precisely the session a stolen token gives.
    */
    if (!MANAGEABLE_ROLES.has(existing.role)) {
      throw new AppError('FORBIDDEN', 'لا يمكن تعديل حساب المالك من هنا.');
    }

    if (existing.role === 'STATION' && input.branchId === null) {
      throw validationFailed(undefined, [
        { path: 'branchId', message: 'حساب المحطة يجب أن يرتبط بفرع' },
      ]);
    }

    if (input.branchId) {
      const branch = await db.branch.findFirst({
        where: { id: input.branchId, merchantId: actor.merchantId },
        select: { id: true },
      });
      if (!branch) {
        throw validationFailed(undefined, [{ path: 'branchId', message: 'الفرع غير موجود' }]);
      }
    }

    await db.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        ...(input.password !== undefined
          ? { passwordHash: await hashPassword(input.password) }
          : {}),
      },
    });

    /*
      Every session belonging to this account is thrown away when its password changes
      or it is deactivated.

      Without this, deactivating a till account leaves whoever holds its refresh token
      trading for as long as they keep rotating it — which is the whole reason somebody
      deactivates an account. The access token still lives out its fifteen minutes;
      revoking the refresh chain is what stops it becoming a permanent session.
    */
    if (input.password !== undefined || input.isActive === false) {
      await db.refreshToken.deleteMany({ where: { userId: id } });
    }

    await recordAudit(
      {
        merchantId: actor.merchantId,
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.USER_UPDATED,
        entityType: 'user',
        entityId: id,
        before: { name: existing.name, isActive: existing.isActive, branchId: existing.branchId },
        after: {
          username: existing.username,
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
          // Recorded as a fact, never as a value.
          ...(input.password !== undefined ? { passwordChanged: true } : {}),
        },
      },
      db,
    );
  });
}
