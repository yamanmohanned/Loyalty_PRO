/**
 * The demo shop, generated.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  This is NOT `seed.ts` and must not become it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `seed.ts` is a **fixture matrix**: eight customers whose amounts are each chosen to
 * render one specific UI state — the cap biting at 185,000, a bracket boundary hit
 * exactly, a customer holding no card. It is the right dataset for development and
 * the wrong one for a demo, because it looks like what it is: eight rows. The Overview
 * capture set showed the consequence — a donut at a 95/5 split, a daily chart that is
 * one spike and a flat tail, and an average basket computed from nineteen invoices.
 *
 * This file produces a **shop**: six months of trading, a customer base that grew over
 * that time, weekday rhythm, a realistic enrolment rate, and baskets drawn from a
 * distribution rather than picked. Nothing here is a placeholder — no «kkkk», no
 * `INV-CAPUT-1`, no lorem. Every name is a real Iraqi name, every amount is a
 * plausible supermarket basket in dinars, every invoice number has the shape a POS
 * actually prints.
 *
 * **Deterministic.** A seeded PRNG, so the same build always produces the same shop
 * and «إعادة تعيين البيانات التجريبية» restores exactly what the merchant first saw.
 * A demo that reshuffles itself on reset is a demo he cannot learn.
 *
 * **The business values are still the engine's.** This file decides *what happened* —
 * who shopped, when, for how much. It never decides what a discount was worth: every
 * invoice is replayed through `ingestInvoice` and `scanCard`, exactly as `seed.ts`
 * does, so the brackets, caps, vouchers and slips are computed by the same code that
 * will compute them in the shop. A bug in `computeDiscount` changes the demo.
 */

/* ── A small deterministic PRNG ───────────────────────────────────────────── */

/**
 * mulberry32 — 32 bits of state, uniform enough for choosing baskets and names.
 *
 * `Math.random()` would make the demo different on every build, which breaks both
 * reproducibility and the reset guarantee. A named constant seed is what makes "the
 * data he saw on Tuesday" a thing that exists.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/* ── Names ────────────────────────────────────────────────────────────────── */

const MALE_FIRST = [
  'أحمد', 'محمد', 'علي', 'حسين', 'مصطفى', 'عمر', 'يوسف', 'كرار', 'مرتضى', 'حيدر',
  'عباس', 'سجاد', 'أمير', 'زيد', 'باسم', 'فراس', 'سيف', 'ليث', 'وسام', 'هيثم',
  'عمار', 'رعد', 'صادق', 'جعفر', 'نبيل', 'طارق', 'سلام', 'قاسم', 'حسن', 'إبراهيم',
] as const;

const FEMALE_FIRST = [
  'فاطمة', 'زينب', 'مريم', 'نور', 'رقية', 'هدى', 'سارة', 'زهراء', 'آية', 'دعاء',
  'شهد', 'رند', 'تبارك', 'بتول', 'إسراء', 'أمل', 'ريام', 'نبأ', 'غفران', 'سجى',
] as const;

const FAMILY = [
  'الجبوري', 'العبيدي', 'الدليمي', 'الزبيدي', 'التميمي', 'الربيعي', 'الخفاجي', 'الساعدي',
  'الكاظمي', 'الطائي', 'العزاوي', 'الشمري', 'الجنابي', 'المالكي', 'الحسناوي', 'البياتي',
  'الفتلاوي', 'الغريري', 'الأسدي', 'الموسوي', 'الحسيني', 'النعيمي', 'القيسي', 'السعدي',
] as const;

/** Iraqi mobile prefixes actually in service: Asiacell, Zain and Korek ranges. */
const PREFIXES = ['0770', '0771', '0780', '0781', '0790', '0791', '0750', '0751'] as const;

/* ── The shop's parameters ────────────────────────────────────────────────── */

export const DEMO = {
  /** Six months, so «آخر سنة» and «آخر 90 يوماً» differ from «آخر 30 يوماً». */
  days: 182,
  customers: 96,
  /**
   * How many of the day's printed invoices reach an enrolled customer.
   *
   * ~38%, drifting upward across the six months — the programme is supposed to be
   * growing. **Not 95%**, which is what the fixture seed produces and which makes the
   * attribution donut a solid ring and the headline metric meaningless.
   */
  enrolmentStart: 0.22,
  enrolmentEnd: 0.47,
  merchantName: 'سوبرماركت الرشيد',
} as const;

/**
 * The weekday curve, Sunday-indexed.
 *
 * Iraq's weekend is Friday–Saturday and Thursday evening is the big shop, so Thursday
 * and Friday carry the week. Monday is the trough. Multipliers, not counts.
 */
const WEEKDAY_WEIGHT = [1.0, 0.82, 0.78, 0.86, 1.35, 1.45, 1.1] as const;

export interface DemoCustomer {
  name: string;
  phone: string;
  category: 'REGULAR' | 'WHOLESALE' | 'VIP';
  /** Days before "today" that they enrolled — the customer base grew over time. */
  joinedDaysAgo: number;
  /** Roughly how often they shop, as a per-day probability. */
  frequency: number;
  /** Their typical basket, in whole dinars. */
  basketMean: number;
  card: 'THERMAL' | 'PRE_PRINTED';
}

export interface DemoInvoice {
  invoiceId: string;
  amountGross: number;
  daysAgo: number;
  captureMode: 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY' | 'MANUAL';
  /** Index into the customer list, or null for an unattributed capture. */
  customer: number | null;
  redeem: boolean;
}

/**
 * A basket size, log-normal-ish.
 *
 * A supermarket's takings are not symmetric around a mean: most people buy bread and
 * a few things, a minority do the weekly shop, and a handful are restaurants buying in
 * bulk. A normal distribution would produce a shop where every basket is average,
 * which is exactly the shape that makes a chart look fake.
 *
 * Rounded to 250 dinars, because a till total ending in 3 does not happen here.
 */
function basket(rng: () => number, mean: number): number {
  const u = Math.max(rng(), 1e-9);
  const v = Math.max(rng(), 1e-9);
  const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const value = mean * Math.exp(gauss * 0.55 - 0.15);
  return Math.max(2_000, Math.round(value / 250) * 250);
}

export function buildDemoCustomers(rng: () => number): DemoCustomer[] {
  const used = new Set<string>();
  const out: DemoCustomer[] = [];

  for (let i = 0; i < DEMO.customers; i++) {
    const female = rng() < 0.42;
    const name = `${pick(rng, female ? FEMALE_FIRST : MALE_FIRST)} ${pick(rng, FAMILY)}`;

    let phone = '';
    do {
      phone = `${pick(rng, PREFIXES)}${between(rng, 100000, 999999)}`;
    } while (used.has(phone));
    used.add(phone);

    // A few wholesale buyers and a VIP tier — the categories the merchant configures
    // are only worth showing if the customer list actually spans them.
    const roll = rng();
    const category = roll < 0.07 ? 'WHOLESALE' : roll < 0.22 ? 'VIP' : 'REGULAR';

    out.push({
      name,
      phone,
      category,
      // Enrolment is spread across the whole window, weighted towards recent — a
      // programme that is being pushed at the till signs people up continuously.
      joinedDaysAgo: Math.floor(DEMO.days * Math.pow(rng(), 0.7)),
      frequency:
        category === 'WHOLESALE' ? 0.1 + rng() * 0.12 : 0.05 + rng() * 0.22,
      basketMean:
        category === 'WHOLESALE'
          ? 150_000 + rng() * 160_000
          : category === 'VIP'
            ? 45_000 + rng() * 45_000
            : 18_000 + rng() * 28_000,
      card: rng() < 0.55 ? 'PRE_PRINTED' : 'THERMAL',
    });
  }

  return out;
}

/**
 * Every invoice the shop printed in the window, attributed or not.
 *
 * Enrolled customers are drawn by their own frequency; the rest of the day's traffic
 * is unattributed walk-in, sized so the attribution rate lands on the target curve.
 * That ordering matters: attribution is an OUTCOME of who happened to shop, not a
 * percentage applied afterwards, so the daily rate wobbles the way a real one does.
 */
export function buildDemoInvoices(rng: () => number, customers: DemoCustomer[]): DemoInvoice[] {
  const invoices: DemoInvoice[] = [];
  let counter = 41_200;

  for (let daysAgo = DEMO.days; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const weekday = WEEKDAY_WEIGHT[date.getDay()]!;

    // Attributed traffic: whoever had enrolled by this date, rolled against frequency.
    const attributed: number[] = [];
    customers.forEach((c, index) => {
      if (c.joinedDaysAgo < daysAgo) return;
      if (rng() < c.frequency * weekday) attributed.push(index);
    });

    // The enrolment rate the shop was running at on this day, plus daily noise.
    const progress = 1 - daysAgo / DEMO.days;
    const target =
      DEMO.enrolmentStart + (DEMO.enrolmentEnd - DEMO.enrolmentStart) * progress;
    const rate = Math.min(0.85, Math.max(0.05, target + (rng() - 0.5) * 0.14));

    const total = Math.max(attributed.length, Math.round(attributed.length / rate));
    const walkIns = total - attributed.length;

    const day: DemoInvoice[] = [];

    for (const index of attributed) {
      const c = customers[index]!;
      day.push({
        invoiceId: `INV-${++counter}`,
        amountGross: basket(rng, c.basketMean),
        daysAgo,
        captureMode: captureMode(rng),
        customer: index,
        // Most slips come back to the till; some are forgotten. ~72% is what the
        // funnel needs to be a funnel rather than three equal bars.
        redeem: rng() < 0.72,
      });
    }

    for (let i = 0; i < walkIns; i++) {
      day.push({
        invoiceId: `INV-${++counter}`,
        amountGross: basket(rng, 22_000),
        daysAgo,
        captureMode: captureMode(rng),
        customer: null,
        redeem: false,
      });
    }

    // Shuffled so the invoice numbers within a day are not "all attributed first",
    // which is the giveaway that a sequence was generated rather than printed.
    for (let i = day.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [day[i], day[j]] = [day[j]!, day[i]!];
    }
    invoices.push(...day);
  }

  return invoices;
}

/**
 * How the invoice reached us.
 *
 * Overwhelmingly the print-spool watcher, which is the mode the agent installs by
 * default; the others appear rarely, because a capture-health panel showing one bar
 * teaches the merchant nothing about what the panel is for.
 */
function captureMode(rng: () => number): DemoInvoice['captureMode'] {
  const r = rng();
  if (r < 0.86) return 'SPOOL_WATCH';
  if (r < 0.93) return 'VIRTUAL_PRINTER';
  if (r < 0.97) return 'NETWORK_PROXY';
  if (r < 0.99) return 'SERIAL_BRIDGE';
  return 'MANUAL';
}
