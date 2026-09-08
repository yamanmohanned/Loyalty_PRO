import type { Customer } from '@prisma/client';
import {
  CardOriginSchema,
  CustomerCategorySchema,
  formatCardNumber,
  formatCardSerial,
  normalizeCardNumber,
  formatPhoneLocal,
  maskPhoneLocal,
  normalizePhone,
  type CreateCustomerRequest,
  type Customer as CustomerDto,
  type CustomerCard,
  type CustomerSearchMatch,
  type CustomerListQuery,
  type CustomerSearchResponse,
  type PhoneE164,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { customerAlreadyExists, notFound, validationFailed } from '../lib/errors';
import { looksLikeBarcodeToken } from '../lib/barcode-token';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import {
  assignCardInTransaction,
  CARD_REJECTION_MESSAGES,
  findActiveCard,
  findAssignableCard,
  issueThermalCard,
  lookupCard,
} from './card.service';
import { enqueueNotification, NOTIFICATION_TEMPLATES } from './notification';

/**
 * The card number a customer currently holds travels with them in the DTO, but it
 * no longer lives on their row (§12.25) — so every serializer takes it as an
 * argument rather than reading it off the customer.
 *
 * Null is a legitimate value: between reporting a card lost and being handed a
 * replacement, a customer holds no card at all and is otherwise entirely intact.
 * The card is a credential; the customer is the identity.
 */
export function serializeCustomer(customer: Customer, cardNumber: string | null): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    // SQLite stores category as a plain string, so parse rather than cast — a bad
    // value should surface here, not leak into a response the UI trusts.
    category: CustomerCategorySchema.parse(customer.category),
    cardNumber,
    createdAt: customer.createdAt.toISOString(),
  };
}

/** Serializes a customer whose active card has to be fetched first. */
async function serializeWithActiveCard(customer: Customer): Promise<CustomerDto> {
  const card = await findActiveCard(customer.merchantId, customer.id);
  return serializeCustomer(customer, card?.cardNumber ?? null);
}

/**
 * Registers a customer and gives them a card.
 *
 * Name and phone only (§6.2 #4): every extra field at the counter costs enrolment.
 * The phone arrives already normalised to E.164 by `PhoneInputSchema` at the request
 * boundary, which is what makes the per-merchant unique constraint mean anything —
 * otherwise one person becomes two accounts.
 *
 * **Two paths, one transaction (§12.25).** The primary path is the operator scanning
 * the blank pre-printed card they are about to hand over; the fallback mints a
 * thermal card when no blank is to hand, so nobody is turned away because the stock
 * drawer is empty. Either way the customer and their card are created together: a
 * customer saved without the card they were handed, or a card claimed for a customer
 * that failed to save, are both states somebody has to unpick by hand at a counter
 * with a queue behind them.
 */
export async function createCustomer(
  params: { merchantId: string; actorUserId: string },
  request: CreateCustomerRequest,
): Promise<CustomerDto> {
  try {
    const { customer, cardNumber } = await writeTransaction(async (db) => {
      // The card is located BEFORE the customer is written. If the operator scanned
      // something unusable — a card already in somebody else's pocket, a voided
      // misprint — the refusal must happen before a half-registered person exists.
      const blank = request.cardNumber
        ? await findAssignableCard(db, params.merchantId, request.cardNumber)
        : null;

      const created = await db.customer.create({
        data: {
          merchantId: params.merchantId,
          name: request.name,
          phone: request.phone,
          category: request.category,
        },
      });

      const issued = blank
        ? await (async () => {
            await assignCardInTransaction(db, {
              merchantId: params.merchantId,
              actorUserId: params.actorUserId,
              customerId: created.id,
              cardId: blank.id,
              cardNumber: blank.cardNumber,
              serial: blank.serial,
            });
            return blank;
          })()
        : await issueThermalCard(db, {
            merchantId: params.merchantId,
            actorUserId: params.actorUserId,
            customerId: created.id,
          });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.CUSTOMER_CREATED,
          entityType: 'customer',
          entityId: created.id,
          after: {
            name: created.name,
            phone: created.phone,
            category: created.category,
            cardSerial: issued.serial === null ? null : formatCardSerial(issued.serial),
            cardOrigin: issued.origin,
          },
        },
        db,
      );

      // A non-fading backup of the card number. Thermal paper fades within weeks in
      // Iraqi heat (§6.3) — less pressing now that the primary card is PVC, and still
      // the only copy a customer has if they lose the plastic one too.
      await enqueueNotification(
        {
          merchantId: params.merchantId,
          customerId: created.id,
          template: NOTIFICATION_TEMPLATES.WELCOME,
          variables: { name: created.name, barcodeToken: issued.cardNumber },
        },
        db,
      );

      return { customer: created, cardNumber: issued.cardNumber };
    });

    return serializeCustomer(customer, cardNumber);
  } catch (error) {
    // Only the phone can collide with a human action. A card-number collision is
    // handled where it happens (`issueThermalCard` retries), so anything reaching
    // here is the phone — the message an operator at the counter actually needs.
    if (isUniqueViolation(error)) throw customerAlreadyExists();
    throw error;
  }
}

/**
 * Resolves a customer at the Loyalty Station from a scanned card or a phone number
 * (CLAUDE_v3.md §6.2).
 *
 * A USB barcode scanner is a keyboard wedge: it types the number and presses Enter,
 * so this receives exactly what is printed on the card.
 *
 * The card branch goes through `lookupCard`, which verifies the check code before
 * any database work and then reads the card's **state**. That is the difference
 * §12.25 introduced: a number can be perfectly genuine and still unusable, and the
 * caller is told which — a card reported lost, superseded, or never issued each gets
 * its own answer rather than a shared "not found" that leaves an operator guessing.
 */
export async function resolveCustomer(
  merchantId: string,
  identifier: string,
): Promise<CustomerDto> {
  const trimmed = identifier.trim();

  if (looksLikeBarcodeToken(trimmed)) {
    const lookup = await lookupCard(merchantId, trimmed);
    if (!lookup.ok) throw notFound(CARD_REJECTION_MESSAGES[lookup.rejection]);

    const customer = await prisma.customer.findFirst({
      where: { id: lookup.customerId, merchantId },
    });
    if (!customer) throw notFound('الزبون غير موجود');
    return serializeCustomer(customer, lookup.card.cardNumber);
  }

  const phone = normalizePhone(trimmed);
  if (!phone) throw validationFailed('المعرّف يجب أن يكون رقم بطاقة أو رقم هاتف صالح');

  const byPhone = await prisma.customer.findUnique({
    where: { merchantId_phone: { merchantId, phone } },
  });
  if (!byPhone) throw notFound('الزبون غير موجود');
  return serializeWithActiveCard(byPhone);
}

export async function getCustomer(merchantId: string, customerId: string): Promise<CustomerDto> {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, merchantId } });
  if (!customer) throw notFound('الزبون غير موجود');
  return serializeWithActiveCard(customer);
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
    const updated = await writeTransaction(async (db) => {
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

    return serializeWithActiveCard(updated);
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
    // Any card the customer has ever held finds them, not only the live one. Someone
    // ringing up holding a card that was replaced last year is still the person whose
    // account this is, and refusing to find them would be the system being right
    // about a technicality and useless to the operator.
    const card = await prisma.card.findFirst({
      where: { merchantId, cardNumber: normalizeCardNumber(trimmed) },
      include: { customer: true },
    });
    const found = card?.customer;
    return {
      matches: found && found.isActive ? [toMatch(found)] : [],
      truncated: false,
    };
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
 *
 * **A reprint is not a replacement (§12.25).** This reproduces the card the customer
 * already holds — a second copy for a wallet, a paper stand-in for plastic left at
 * home. A card that is gone or compromised needs `replaceCard`, which retires the old
 * number so whoever finds it cannot use it. Confusing the two would leave a lost card
 * live, which is the one outcome the LOST state exists to prevent.
 */
export async function getCustomerCard(
  merchantId: string,
  customerId: string,
): Promise<CustomerCard> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, merchantId, isActive: true },
  });
  if (!customer) throw notFound('الزبون غير موجود');

  const card = await findActiveCard(merchantId, customerId);
  if (!card) {
    // No live card: reported lost and not yet replaced. Reprinting is the wrong
    // remedy and there is nothing to reprint, so say so rather than failing vaguely.
    throw notFound('لا توجد بطاقة فعّالة لهذا الزبون — أصدر بطاقة بديلة');
  }

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    phoneLocal: formatPhoneLocal(customer.phone as PhoneE164),
    cardNumber: card.cardNumber,
    cardNumberFormatted: formatCardNumber(card.cardNumber),
    serialFormatted: card.serial === null ? null : formatCardSerial(card.serial),
    origin: CardOriginSchema.parse(card.origin),
    createdAt: customer.createdAt.toISOString(),
  };
}

/* ── The dashboard list (Stitch: الزبائن) ─────────────────────────────────── */

export interface CustomerListRow {
  id: string;
  name: string;
  phone: string;
  category: string;
  cardNumber: string | null;
  lifetimeSpend: number;
  transactionCount: number;
  createdAt: string;
}

export interface CustomerListResult {
  customers: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The paged, filterable customer list.
 *
 * The query schema for this has existed in `shared-types` since v1 and had no
 * endpoint behind it — the dashboard shipped with a single-customer lookup instead,
 * which answers "who is this phone number?" and cannot answer "who are my
 * customers?". This is the list.
 *
 * **Sorting by spend is not sorting by a column.** Cumulative spend is derived from
 * transactions in the active period and is never stored (§5.3), so it cannot appear
 * in an ORDER BY. The ranking is computed from one grouped query over the current
 * period and applied in memory; customers with no spend in the period sort last,
 * which is what a merchant means by "highest spending" rather than an accident of
 * NULL ordering.
 *
 * The bound on that, stated rather than assumed: the grouped query returns at most
 * one row per customer who bought something this period. At one supermarket that is
 * thousands of rows, in the same territory as §12.23's note about `getOverview`.
 * Revisit together with that one, not before.
 */
export async function listCustomers(
  merchantId: string,
  query: CustomerListQuery,
): Promise<CustomerListResult> {
  const where = {
    merchantId,
    isActive: true,
    ...(query.category ? { category: query.category } : {}),
    // A phone PREFIX, never a name (CLAUDE.md §1.4). The filter narrows a list the
    // manager is already looking at; it is not an identification path.
    ...(query.phone ? { phone: { contains: query.phone } } : {}),
  };

  const total = await prisma.customer.count({ where });

  // Lifetime, not period — nothing bounds it now (§10.6). It is history shown beside
  // a customer's name, never an input to what they are offered at the till (§1.4).
  const spend = await prisma.transaction.groupBy({
    by: ['customerId'],
    where: { merchantId, customerId: { not: null } },
    _sum: { amountGross: true },
    _count: { _all: true },
  });

  const spendById = new Map(
    spend.map((row) => [
      row.customerId as string,
      { amount: row._sum.amountGross ?? 0, count: row._count._all },
    ]),
  );

  const skip = (query.page - 1) * query.pageSize;

  // Name and registration date are real columns, so the database pages them. Spend
  // is not, so that branch ranks in memory and pages the result.
  let customers;
  if (query.sort === 'lifetimeSpend') {
    const all = await prisma.customer.findMany({ where, include: { cards: true } });
    const direction = query.order === 'asc' ? 1 : -1;
    customers = all
      .sort((a, b) => {
        const difference =
          (spendById.get(a.id)?.amount ?? 0) - (spendById.get(b.id)?.amount ?? 0);
        // Ties broken by registration date so the order is stable between pages —
        // an unstable sort silently shows or hides a customer as you page through.
        return difference !== 0
          ? difference * direction
          : b.createdAt.getTime() - a.createdAt.getTime();
      })
      .slice(skip, skip + query.pageSize);
  } else {
    customers = await prisma.customer.findMany({
      where,
      include: { cards: true },
      orderBy: { [query.sort]: query.order },
      skip,
      take: query.pageSize,
    });
  }

  return {
    customers: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      category: customer.category,
      cardNumber:
        customer.cards.find((card) => card.status === 'ASSIGNED')?.cardNumber ?? null,
      lifetimeSpend: spendById.get(customer.id)?.amount ?? 0,
      transactionCount: spendById.get(customer.id)?.count ?? 0,
      createdAt: customer.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The whole customer list as CSV.
 *
 * **Audited, and it carries phone numbers.** §7.11 calls the phone the one
 * identifier worth protecting here, and this endpoint hands every one of them to
 * whoever asked. That makes "who exported the customer list, and when" a question
 * somebody will eventually need answered — the same reasoning as the card batch
 * export (§12.25), for the same kind of file.
 */
export async function exportCustomersCsv(params: {
  merchantId: string;
  actorUserId: string;
}): Promise<string> {
  const [customers, spend] = await Promise.all([
    prisma.customer.findMany({
      where: { merchantId: params.merchantId, isActive: true },
      include: { cards: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.transaction.groupBy({
      by: ['customerId'],
      where: { merchantId: params.merchantId, customerId: { not: null } },
      _sum: { amountGross: true },
    }),
  ]);

  const spendById = new Map(
    spend.map((row) => [row.customerId as string, row._sum.amountGross ?? 0]),
  );

  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const rows = customers.map((customer) =>
    [
      customer.name,
      customer.phone,
      customer.category,
      customer.cards.find((card) => card.status === 'ASSIGNED')?.cardNumber ?? '',
      String(spendById.get(customer.id) ?? 0),
      customer.createdAt.toISOString(),
    ]
      .map(escape)
      .join(','),
  );

  await recordAudit({
    merchantId: params.merchantId,
    actorUserId: params.actorUserId,
    action: AUDIT_ACTIONS.CUSTOMER_LIST_EXPORTED,
    entityType: 'customer',
    entityId: params.merchantId,
    after: { rows: customers.length },
  });

  return ['name,phone,category,card_number,cumulative_amount,created_at', ...rows].join('\r\n');
}
