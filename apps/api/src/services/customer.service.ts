import type { Customer, Prisma } from '@prisma/client';
import {
  normalizePhone,
  type CreateCustomerRequest,
  type Customer as CustomerDto,
  type CustomerListQuery,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import { customerAlreadyExists, notFound, validationFailed } from '../lib/errors';
import { generateQrToken, looksLikeQrToken, verifyQrToken } from '../lib/qr-token';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { enqueueNotification, NOTIFICATION_TEMPLATES } from './notification';

const env = loadEnv();

export function serializeCustomer(customer: Customer): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    category: customer.category,
    qrToken: customer.qrToken,
    createdAt: customer.createdAt.toISOString(),
  };
}

/**
 * Registers a customer and mints their permanent QR token.
 *
 * The phone arrives already normalised to E.164 by `PhoneInputSchema` at the
 * request boundary, which is what makes the per-merchant unique constraint mean
 * anything — see CLAUDE.md §13.4.
 */
export async function createCustomer(
  params: { merchantId: string; actorUserId: string },
  request: CreateCustomerRequest,
): Promise<CustomerDto> {
  try {
    const customer = await prisma.$transaction(async (db) => {
      const created = await db.customer.create({
        data: {
          merchantId: params.merchantId,
          name: request.name,
          phone: request.phone,
          category: request.category,
          qrToken: generateQrToken(env.QR_TOKEN_SECRET),
        },
      });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.CUSTOMER_CREATED,
          entityType: 'customer',
          entityId: created.id,
          after: { name: created.name, phone: created.phone, category: created.category },
        },
        db,
      );

      // Carries the QR to the customer's WhatsApp — the primary way they will
      // present themselves at the register from now on.
      await enqueueNotification(
        {
          merchantId: params.merchantId,
          customerId: created.id,
          template: NOTIFICATION_TEMPLATES.WELCOME,
          variables: { name: created.name, qrToken: created.qrToken },
        },
        db,
      );

      return created;
    });

    return serializeCustomer(customer);
  } catch (error) {
    if (isUniqueViolation(error)) throw customerAlreadyExists();
    throw error;
  }
}

/**
 * Resolves a customer at the register from a QR token or a phone number
 * (CLAUDE.md §1.4).
 *
 * Name search is deliberately impossible here: a name is not unique, and picking
 * from a list of matches is far too slow with a queue waiting. The identifier is
 * either a signed QR token or a phone number, both of which resolve to exactly one
 * account or to nothing.
 */
export async function resolveCustomer(
  merchantId: string,
  identifier: string,
): Promise<CustomerDto> {
  const trimmed = identifier.trim();

  if (looksLikeQrToken(trimmed)) {
    // Signature first: a forged or corrupted scan is rejected without touching the
    // database, which keeps the register fast and denies an enumeration oracle.
    if (!verifyQrToken(trimmed, env.QR_TOKEN_SECRET)) {
      throw notFound('رمز الزبون غير صالح');
    }
    const byToken = await prisma.customer.findFirst({
      where: { qrToken: trimmed, merchantId },
    });
    if (!byToken) throw notFound('الزبون غير موجود');
    return serializeCustomer(byToken);
  }

  const phone = normalizePhone(trimmed);
  if (!phone) throw validationFailed('المعرّف يجب أن يكون رمز QR أو رقم هاتف صالح');

  const byPhone = await prisma.customer.findUnique({
    where: { merchantId_phone: { merchantId, phone } },
  });
  if (!byPhone) throw notFound('الزبون غير موجود');
  return serializeCustomer(byPhone);
}

export async function getCustomer(merchantId: string, customerId: string): Promise<CustomerDto> {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, merchantId } });
  if (!customer) throw notFound('الزبون غير موجود');
  return serializeCustomer(customer);
}

export async function updateCustomer(
  params: { merchantId: string; customerId: string; actorUserId: string },
  request: UpdateCustomerRequest,
): Promise<CustomerDto> {
  const before = await prisma.customer.findFirst({
    where: { id: params.customerId, merchantId: params.merchantId },
  });
  if (!before) throw notFound('الزبون غير موجود');

  try {
    const updated = await prisma.$transaction(async (db) => {
      const next = await db.customer.update({
        where: { id: params.customerId },
        data: {
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.phone !== undefined ? { phone: request.phone } : {}),
          ...(request.category !== undefined ? { category: request.category } : {}),
        },
      });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
          entityType: 'customer',
          entityId: next.id,
          before: { name: before.name, phone: before.phone, category: before.category },
          after: { name: next.name, phone: next.phone, category: next.category },
        },
        db,
      );

      return next;
    });

    return serializeCustomer(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw customerAlreadyExists();
    throw error;
  }
}

/**
 * Dashboard listing. Sorting by cumulative spend reads the derived snapshot cache
 * rather than aggregating transactions per row, which is the whole reason the
 * cache exists (CLAUDE.md §8).
 */
export async function listCustomers(
  merchantId: string,
  query: CustomerListQuery,
  currentPeriodKey: string,
): Promise<{ items: Array<CustomerDto & { cumulativeAmount: number }>; total: number; page: number; pageSize: number }> {
  const where: Prisma.CustomerWhereInput = {
    merchantId,
    ...(query.category ? { category: query.category } : {}),
    // Phone PREFIX matching only — never a name search (CLAUDE.md §1.4).
    ...(query.phone ? { phone: { contains: query.phone.replace(/^0/, '') } } : {}),
  };

  const total = await prisma.customer.count({ where });

  const customers = await prisma.customer.findMany({
    where,
    include: { balanceSnapshots: { where: { periodKey: currentPeriodKey }, take: 1 } },
    orderBy:
      query.sort === 'name'
        ? { name: query.order }
        : query.sort === 'cumulativeAmount'
          ? { createdAt: query.order } // re-sorted below; the snapshot is a relation
          : { createdAt: query.order },
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  });

  const items = customers.map((customer) => ({
    ...serializeCustomer(customer),
    cumulativeAmount: customer.balanceSnapshots[0]?.cumulativeAmount ?? 0,
  }));

  if (query.sort === 'cumulativeAmount') {
    items.sort((a, b) =>
      query.order === 'asc'
        ? a.cumulativeAmount - b.cumulativeAmount
        : b.cumulativeAmount - a.cumulativeAmount,
    );
  }

  return { items, total, page: query.page, pageSize: query.pageSize };
}
