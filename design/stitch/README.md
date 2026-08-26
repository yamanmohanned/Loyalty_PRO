# Stitch design exports

Vendored from the Stitch project **`12203193888392364805`** on 2026-08-25 via the
Stitch MCP connector. These are the **layout source of truth** for the two apps
(CLAUDE.md §6 preamble).

Do not edit these files. They are a snapshot of upstream — if a screen changes in
Stitch, re-export it here rather than patching the copy.

## Authority

| Concern | Authority |
|---|---|
| Layout, composition, screen structure | **These files** |
| Colour, typography, spacing | **`packages/config/src/tokens.ts`** (CLAUDE.md §6.2–§6.3) |
| Everything else | CLAUDE.md |

Where a Stitch screen and the tokens disagree, the tokens win.

`DESIGN.md` is Stitch's own design-system brief. It was checked against CLAUDE.md §6
on import and **matches it exactly** — same palette, same font stack, same
anti-patterns. No reconciliation was needed.

## Screen inventory

All 17 screens carry `dir="rtl" lang="ar"` upstream.

### Dashboard (web) — 7 of 8

| File | Screen |
|---|---|
| `dashboard-login.html` | تسجيل الدخول |
| `dashboard-overview.html` | نظرة عامة |
| `dashboard-customers.html` | الزبائن |
| `dashboard-customer-detail.html` | تفاصيل الزبون |
| `dashboard-rules.html` | قواعد الولاء |
| `dashboard-reports.html` | التقارير |
| `dashboard-settings.html` | الإعدادات |
| — | **التكاملات (Integrations) — absent upstream, see below** |

### Assistant (mobile) — 9 of 9, plus one bonus

| File | Screen |
|---|---|
| `assistant-login.html` | تسجيل الدخول |
| `assistant-home.html` | الرئيسية (ready-to-scan) |
| `assistant-scan-customer.html` | مسح كود الزبون |
| `assistant-phone-fallback.html` | البحث برقم الهاتف |
| `assistant-scan-invoice.html` | مسح الفاتورة + المبلغ |
| `assistant-success.html` | تأكيد النجاح |
| `assistant-register-customer.html` | تسجيل زبون جديد |
| `assistant-register-success.html` | نجاح التسجيل *(bonus — not in §6.8)* |
| `assistant-redeem-coupon.html` | استخدام الكوبون |
| `assistant-transactions.html` | سجل العمليات |

Two scratch screens in the upstream project (`Shader`, `Three.js` — both 512×512
WebGL experiments) were deliberately **not** imported; they are unrelated to this
product.

## Required modifications (CLAUDE.md §6.7)

These are applied **on top of** these exports during Phases 2 and 3. They are not
reflected in the files here.

1. **Integrations screen** — build from tokens; no upstream design exists. Shows
   per-branch operating mode, connection status and sync health. Only
   "المسح اليدوي (Universal Mode)" is active; API and DB Agent render as
   "غير مفعّل" placeholders.
2. **Invoice amount screen** — must render **both** states: auto-filled (green
   "تمت القراءة تلقائياً" + editable "تعديل") and manual entry (oversized monospace
   input). Verify the upstream screen covers both before implementing.
3. **Sync status indicators** — متصل / قيد المزامنة / غير متصل on the assistant Home
   and Transactions screens. Add if absent upstream.
4. **RTL correctness pass** — auto-generated designs mis-mirror direction routinely.
   Verify: nav rail on the right, "back" chevrons point right, text right-aligns,
   no horizontal overflow on mobile.
5. **Coupon redemption screen** — must prominently show the cashier instruction
   ("أبلغ الكاشير بتطبيق خصم X٪"), since discounts are applied by hand on the main
   register.

## Known deviations from the tokens

Spotted on import; correct these when implementing rather than copying them across:

- Screens load **Plus Jakarta Sans**, which is not in the token set. Use Cairo /
  IBM Plex Sans Arabic / IBM Plex Mono only (CLAUDE.md §6.3).
- Screens use **Material Symbols** for icons. DESIGN.md §8 calls for Lucide/Phosphor-style
  line icons.
- Screens load Tailwind from a CDN (`cdn.tailwindcss.com`). The real apps use the
  shared preset at `packages/config/tailwind/preset.cjs`.
