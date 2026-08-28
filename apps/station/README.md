# `apps/station` — the Loyalty Station

The screen beside the register. A customer scans their card; the station tells them
one of four things and, when they have earned a discount, prints the slip they hand to
the cashier (CLAUDE_v3.md §6).

**One screen, one field, learnable in two minutes.** Everything configurable lives in
the manager app behind manager authentication — there is no settings screen here, and
adding one would be a change to §6.4, not a feature.

---

## Running it

```bash
pnpm --filter @walaa/station dev     # http://localhost:5174
```

It needs an API. In development that is usually the repo's own:

```bash
pnpm --filter @walaa/api dev         # port 4000
```

If port 4000 is taken — most likely by an **installed** Walaa service, which is a
different database — run the development API beside it:

```bash
pnpm --filter @walaa/api dev:alt     # port 4001, same repo database
```

On first load the station asks for the server address. In production it does not: the
API serves this bundle from its own port, so the origin the browser loaded is already
the answer.

---

## How it is put together

| Path                       | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `screens/Scan.tsx`         | the main screen — one focused field, four outcomes             |
| `screens/Register.tsx`     | name and phone only, then prints the card                      |
| `screens/Reprint.tsx`      | find a customer who lost their card; reissues the same number  |
| `components/Printable.tsx` | what the thermal printer actually receives                     |
| `components/Barcode.tsx`   | the card's Code 128C symbol, as SVG                            |
| `lib/queue.ts`             | the offline queue and the connection indicator                 |
| `lib/realtime.ts`          | the persistent link, and the honest answer to "are we online?" |
| `lib/print.tsx`            | mounts a job into `#print-root` and calls `window.print()`     |
| `lib/locale.ts`            | every string in the app                                        |

---

## Things that will surprise you

**The scan field takes the focus back, continuously.** A USB scanner types into
whatever is focused and gives no feedback; if focus drifts, scans vanish silently. The
one case where focus is not stolen is when the operator is typing in another field.

**Submission does not rely on the Enter key.** Scanners can be configured to send
Enter, Tab, or nothing at all. The field submits on any of the three — the third by
noticing it holds a complete sixteen-digit card number.

**A scan taken offline gets no discount slip, and the screen says so.** The sale is
settled in cash before the queued scan reaches the server, so issuing a voucher then
would put a slip in the books that never existed on paper (§0 rule 3). The customer's
spend is still credited toward their next discount.

**Printing uses the browser's print dialog.** That is deliberate — a web app cannot
drive a USB printer, and a bridge service would be one more thing to install in every
shop. **In the field, enable kiosk printing** so slips print without a dialog:

```
chrome.exe --kiosk-printing --kiosk http://<manager-lan-ip>:4000
```

**The connection indicator is driven by a socket, not by `navigator.onLine`.** That
flag reports whether the OS has _a_ network, which stays true while the manager PC is
asleep or behind a router that has started isolating clients. The station holds a
WebSocket and trusts the server's greeting — an authenticated round trip — as its
definition of "connected". Reconnection backs off and flushes the queue on success.

**Fonts are bundled, never fetched.** A shop LAN has no outbound internet (§7.1). The
clean-room packaging test asserts the served page requests nothing from a font CDN.

---

## Verifying a change

The API-side behaviour has tests (`apps/api/src/__tests__/station.test.ts`,
`settlement.test.ts`). The UI is verified in a browser, and the flows worth re-running
after a change are:

1. **Scan a known card with a pending invoice** → qualified, amounts correct, slip
   contains before / discount / after / instruction / voucher code.
2. **Scan an unknown number** → registration offer, not an error.
3. **Scan with nothing pending** → "ask the cashier to print the receipt first".
4. **Register** → card prints with a scannable barcode and the number in text.
5. **Reprint** → the same number the registration produced, never a new one.
6. **Offline** → queued, honest message, and after reconnect the transaction is
   attributed with `discountValue = 0` and no voucher row.
7. **375 px wide** → no horizontal scroll, controls at least 48 px tall, `dir="rtl"`.
