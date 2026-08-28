import type { Customer } from '@prisma/client';
import {
  CustomerCategorySchema,
  normalizePhone,
  type CreateCustomerRequest,
  type Customer as CustomerDto,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import { customerAlreadyExists, notFound, validationFailed } from '../lib/errors';
import { generateBarcodeToken, looksLikeBarcodeToken, verifyBarcodeToken } from '../lib/barcode-token';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { enqueueNotification, NOTIFICATION_TEMPLATES } from './notification';

const env = loadEnv();

export function serializeCustomer(customer: Customer): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    // SQLite stores category as a plain string, so parse rather than cast — a bad
    // value should surface here, not leak into a response the UI trusts.
    category: CustomerCategorySchema.parse(customer.category),
    barcodeToken: customer.barcodeToken,
    createdAt: customer.createdAt.toISOString(),
  };
}

/**
 * Registers a customer and mints their permanent card barcode.
 *
 * Name and phone only (§6.2 #4): every extra field at the counter costs enrolment.
 * The phone arrives already normalised to E.164 by `PhoneInputSchema` at the
 * request boundary, which is what makes the per-merchant unique constraint mean
 * anything — otherwise one person becomes two accounts.
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
          barcodeToken: generateBarcodeToken(env.QR_TOKEN_SECRET),
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

      // A non-fading backup of the card code. Thermal paper fades within weeks in
      // Iraqi heat (§6.3), so the WhatsApp copy matters — when the module is on.
      await enqueueNotification(
        {
          merchantId: params.merchantId,
          customerId: created.id,
          template: NOTIFICATION_TEMPLATES.WELCOME,
          variables: { name: created.name, barcodeToken: created.barcodeToken },
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
 * Resolves a customer at the Loyalty Station from a scanned card token or a phone
 * number (CLAUDE_v3.md §6.2).
 *
 * A USB barcode scanner is a keyboard wedge: it types the code and presses Enter,
 * so this receives exactly what was printed on the card. Phone lookup exists for
 * card reprint, where the customer has lost the card they would otherwise scan.
 */
export async function resolveCustomer(
  merchantId: string,
  identifier: string,
): Promise<CustomerDto> {
  const trimmed = identifier.trim();

  if (looksLikeBarcodeToken(trimmed)) {
    // Signature first: a forged or mis-scanned code is rejected without touching
    // the database, which keeps the station fast and denies an enumeration oracle.
    if (!verifyBarcodeToken(trimmed, env.QR_TOKEN_SECRET)) {
      throw notFound('رمز البطاقة غير صالح');
    }
    const byToken = await prisma.customer.findFirst({
      where: { barcodeToken: trimmed, merchantId },
    });
    if (!byToken) throw notFound('الزبون غير موجود');
    return serializeCustomer(byToken);
  }

  const phone = normalizePhone(trimmed);
  if (!phone) throw validationFailed('المعرّف يجب أن يكون رمز بطاقة أو رقم هاتف صالح');

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
