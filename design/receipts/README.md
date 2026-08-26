# Reference receipts

> ## ⚠ These are reconstructions, not real receipts
>
> As of 2026-08-25 the merchant has not supplied a sample receipt, so the register's
> actual barcode encoding is **unconfirmed** (CLAUDE.md §13.6). Everything here is a
> considered guess built to plausible POS conventions.
>
> **They are correct in the ways that can be verified without the merchant** — the
> paper geometry is the industry standard, and the barcodes are real, checksummed
> Code 128 symbols that decode. **They are a guess in the one way that matters most:
> what the real register actually prints into the symbol.**
>
> When a real receipt arrives, compare it against this and adjust. The likely outcome
> is that one of the two parsers already matches; if not, adding the real format means
> writing one more parser and changing nothing else.

## Paper geometry

Modelled on the 80 mm thermal roll used by essentially every supermarket POS printer
(Epson TM-T88 class, Bixolon SRP-350 class, and the many clones sold in the region).

| Property | Value | Notes |
|---|---|---|
| Roll width | 80 mm | The physical paper |
| **Printable width** | **72 mm** | Standard for an 80 mm roll |
| Head resolution | 203 dpi (8 dots/mm) | The near-universal thermal density |
| **Printable dots** | **576** | 72 mm × 8 dots/mm |
| Length | continuous | Set by content, not by a page size |
| Colour depth | 1-bit | Thermal heads burn a dot or they do not — there is no greyscale |

The rendered PNGs are **576 × 1002 px = 72 mm × 125.3 mm**, thresholded to pure black
and white because that is what a thermal printer physically produces.

The 57 mm roll (48 mm printable, 384 dots) also exists, but is used for handhelds and
small kiosks rather than supermarket lanes.

## The two variants

Both encode **Code 128 Set B**, with a 2-dot narrow module (0.25 mm) and a 70-dot
(≈8.75 mm) symbol height — typical retail settings.

### `walaa-receipt-invoice-only.png` — the realistic default

```
payload:  INV-9824
```

The printed document number alone. This is what retail POS software overwhelmingly
does, and it is the format the platform assumes until told otherwise. **The amount is
not in the symbol**, so the assistant enters it by hand — which is exactly why the
invoice screen must render both an auto-filled and a manual state (CLAUDE.md §6.7 #2).

### `walaa-receipt-with-amount.png` — the auto-capture path

```
payload:  INV-9824|85000
```

A register configured to append the total. Less common, but worth supporting: if the
merchant's POS can be configured this way, the assistant skips a manual step on every
single transaction, which is the single largest speed win available in the core loop.

A third field is tolerated and ignored (`INV-9824|85000|BAG-01`).

## Receipt contents

The fixture is internally consistent so it can be trusted in tests: line totals sum to
the subtotal, subtotal minus discount equals the total, and tender minus total equals
the change.

| Field | Value |
|---|---|
| Store / branch | سوبرماركت الرشيد — فرع الكرادة |
| Invoice | `INV-9824` |
| Branch code | `BAG-01` |
| Line items | 9 lines, 26 pieces |
| Subtotal | 86,000 IQD |
| Discount | −1,000 IQD |
| **Total** | **85,000 IQD** |

The invoice number and total deliberately match the worked example in CLAUDE.md §2.3,
so the fixture, the schema documentation and the tests all describe one coherent sale.

## Files

| File | What it is |
|---|---|
| `generate.html` | The generator. Open it in a browser to see both receipts; `?export=0` / `?export=1` render one full-bleed for headless capture. Contains a complete Code 128 encoder. |
| `verify-barcode.mjs` | Decodes the barcodes back **out of the rendered PNG pixels** and checks the checksums. This is what makes the fixtures trustworthy — a barcode that merely looks like a barcode is useless. |
| `*.png` | The rendered receipts. |

## Regenerating

```bash
node design/receipts/verify-barcode.mjs
```

To re-render the PNGs after editing `generate.html`:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=576,1002 --screenshot=design/receipts/walaa-receipt-invoice-only.png "file:///E:/loyalty/design/receipts/generate.html?export=0"
```

Always re-run `verify-barcode.mjs` afterwards — it is the only thing standing between a
fixture and a decorative picture of a barcode.

## Where the parsers live

`packages/shared-types/src/invoice-parsers.ts`, tested in
`packages/shared-types/src/__tests__/invoice-parsers.test.ts` against these exact
payloads.

Two rules every parser honours:

1. **The invoice number is mandatory; the amount is not.** `amount: null` is a normal
   result, not a failure.
2. **A doubtful amount is worse than no amount.** A wrong amount silently corrupts a
   customer's balance; a null one merely asks the assistant to type four digits.
