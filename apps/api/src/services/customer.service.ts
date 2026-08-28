import type { Customer } from '@prisma/client';
import {
  CustomerCategorySchema,
  formatCardNumber,
  formatPhoneLocal,
  maskPhoneLocal,
  normalizePhone,
  type CreateCustomerRequest,
  type Customer as CustomerDto,
  type CustomerCard,
  type CustomerSearchMatch,
  type CustomerSearchResponse,
  type PhoneE164,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import { customerAlreadyExists, notFound, validationFailed } from '../lib/errors';
import {
  canonicalizeBarcodeToken,
  generateBarcodeToken,
  looksLikeBarcodeToken,
  verifyBarcodeToken,
} from '../lib/barcode-token';
import { isUniqueViolation, prisma, uniqueViolationTargets } from '../lib/prisma';
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
/**
 * A minted card number that was already taken.
 *
 * Internal to this module: `createCustomer` retries and the caller never sees it.
 * It exists so a collision cannot be mistaken for "this phone is already
 * registered", which is what the shared unique-violation handler would otherwise
 * report — a message that would send an operator looking for a customer who is not
 * there.
 */
class CardNumberCollision extends Error {
  constructor() {
    super('card number collision');
    this.name = 'CardNumberCollision';
  }
}

/** How many fresh numbers to try before giving up. */
const CARD_NUMBER_ATTEMPTS = 5;

/**
 * Registers a customer, retrying if a minted card number is already in use.
 *
 * Ten random digits give ten billion numbers, so for one supermarket a collision is
 * a curiosity rather than a risk — but "unlikely" is not "impossible", and the
 * failure it would otherwise produce (a spurious "already registered" at the
 * counter) is the kind that gets blamed on the customer.
 */
export async function createCustomer(
  params: { merchantId: string; actorUserId: string },
  request: CreateCustomerRequest,
): Promise<CustomerDto> {
  for (let attempt = 1; attempt <= CARD_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await createCustomerOnce(params, request);
    } catch (error) {
      if (error instanceof CardNumberCollision && attempt < CARD_NUMBER_ATTEMPTS) continue;
      if (error instanceof CardNumberCollision) {
        throw validationFailed('تعذّر إنشاء رقم بطاقة فريد — أعد المحاولة');
      }
      throw error;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw validationFailed('تعذّر إنشاء رقم بطاقة فريد — أعد المحاولة');
}

async function createCustomerOnce(
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
    if (isUniqueViolation(error)) {
      // Which unique constraint fired matters. The phone is the one a person can
      // collide with by re-registering, and it is the message the operator needs.
      // A card-number collision is a coincidence in a ten-billion space, not a
      // duplicate customer, and it must not be reported as one — the caller retries.
      if (uniqueViolationTargets(error, 'barcode_token')) throw new CardNumberCollision();
      throw customerAlreadyExists();
    }
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
      throw notFound('رقم البطاقة غير صالح');
    }
    // Bare digits are the storage form. A number read aloud and typed back with the
    // grouping printed on the card — or on an Arabic keypad — must find the same row
    // the scanner does.
    const byToken = await prisma.customer.findFirst({
      where: { barcodeToken: canonicalizeBarcodeToken(trimmed), merchantId },
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

/** How many disambiguation candidates a name search returns before asking for more. */
const SEARCH_LIMIT = 8;

/**
 * Finds a customer who has lost their card (§6.2 #5).
 *
 * One input, three shapes, most specific first:
 *
 *  1. **Card number** — sixteen digits. Signature-checked, so a mistyped one fails
 *     without a query, exactly as at the scan screen.
 *  2. **Phone number** — unique per merchant, so it resolves to one person.
 *  3. **Name** — the fallback, and the only one that can return several people.
 *
 * The name branch returns masked phone numbers and a bounded list. That is the whole
 * mitigation for the tension with CLAUDE.md §1.4: the operator can confirm "the one
 * ending 4567?" with the customer present, and cannot read the shop's phone list off
 * the screen.
 */
export async function searchCustomers(
  merchantId: string,
  query: string,
): Promise<CustomerSearchResponse> {
  const trimmed = query.trim();

  const toMatch = (customer: Customer): CustomerSearchMatch => ({
    id: customer.id,
    name: customer.name,
    phoneMasked: maskPhoneLocal(customer.phone as PhoneE164),
    createdAt: customer.createdAt.toISOString(),
  });

  if (looksLikeBarcodeToken(trimmed)) {
    if (!verifyBarcodeToken(trimmed, env.QR_TOKEN_SECRET)) return { matches: [], truncated: false };
    const byToken = await prisma.customer.findFirst({
      where: { barcodeToken: canonicalizeBarcodeToken(trimmed), merchantId, isActive: true },
    });
    return { matches: byToken ? [toMatch(byToken)] : [], truncated: false };
  }

  const phone = normalizePhone(trimmed);
  if (phone) {
    const byPhone = await prisma.customer.findUnique({
      where: { merchantId_phone: { merchantId, phone } },
    });
    return {
      matches: byPhone && byPhone.isActive ? [toMatch(byPhone)] : [],
      truncated: false,
    };
  }

  // Name. One extra row is fetched purely to answer "is there more?" — the operator
  // needs to know their list is incomplete, or they will confidently pick the wrong
  // person from a truncated one.
  const byName = await prisma.customer.findMany({
    where: { merchantId, isActive: true, name: { contains: trimmed } },
    orderBy: { createdAt: 'desc' },
    take: SEARCH_LIMIT + 1,
  });

  return {
    matches: byName.slice(0, SEARCH_LIMIT).map(toMatch),
    truncated: byName.length > SEARCH_LIMIT,
  };
}

/**
 * The card details for a reprint.
 *
 * Reissues the SAME number (§6.2 #5). A new one would sever the customer from their
 * own purchase history, which is the one thing a loyalty programme may never do.
 */
export async function getCustomerCard(
  merchantId: string,
  customerId: string,
): Promise<CustomerCard> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, merchantId, isActive: true },
  });
  if (!customer) throw notFound('الزبون غير موجود');

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    phoneLocal: formatPhoneLocal(customer.phone as PhoneE164),
    barcodeToken: customer.barcodeToken,
    cardNumberFormatted: formatCardNumber(customer.barcodeToken),
    createdAt: customer.createdAt.toISOString(),
  };
}
