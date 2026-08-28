# V3-0 Audit — Risks

Heuristics and measured facts, not confirmed defects. Ordered by severity.

## R1 — C: drive is 100% full (146 MB free) — BLOCKING

Measured: `C: 119G total, 118G used, 146M free`.

This already stopped Phase 2: `pnpm install` for the dashboard failed, which is why
`@walaa/dashboard` does not typecheck. It will equally block:
- the Rust toolchain (~2 GB for rustup + cargo registry + target dirs)
- any further npm installs (temp space)
- Docker, whose containerd metadata already flipped read-only once during Phase 1
  and dropped the Postgres port mapping

Mitigations available:
- Relocate `CARGO_HOME` / `RUSTUP_HOME` / `TEMP` to E: (98 GB free). pnpm's store is
  already on E:.
- **The v3 SQLite migration helps here**: retiring Postgres lets ~4.3 GB of Docker
  VM disk be reclaimed from C:.

## R2 — "Only the provider changes" understates the SQLite migration

CLAUDE_v3 §5.1 says to keep Prisma and change only the provider. The audit found
concrete Postgres-specific dependencies that will not survive that swap:

| Dependency | Where | Impact |
|---|---|---|
| **Prisma `enum`** — unsupported on SQLite | 9 enums in `schema.prisma` | All become `String`; validation moves to Zod. Touches every model and every service. |
| `@db.Uuid` native type | every model PK/FK | Becomes `String`; `uuid()` defaults still fine |
| `isolationLevel: 'Serializable'` | `transaction.service.ts` | Prisma interactive-transaction isolation is not supported on SQLite. The core loop's concurrency guarantee needs re-establishing (WAL + single-writer semantics). |
| `::BIGINT`, `::uuid` casts | `reports.service.ts` (5 raw queries) | SQLite has no such casts |
| `AT TIME ZONE`, `to_char` | `reports.service.ts` timeseries | No timezone support in SQLite — day bucketing must move into JS |
| `Json` column type | `notification_log.payload`, `audit_log.before/after` | Becomes `String`; serialize explicitly |
| `TRUNCATE ... CASCADE` | test helper `db.ts` | Not supported; becomes `DELETE FROM` per table |

`reports.service.ts` is 428 lines and is the single most affected file. Realistically
it is a **REWRITE**, not a REVISE.

## R3 — Runtime topology is under-specified and v2/v3 conflict

CLAUDE_v3 §3 says the Manager Desktop machine "hosts the local API service (Windows
Service, starts with the machine) and the SQLite database". CLAUDE_v2 §8 specifies a
hosted VPS with Docker, Caddy and Let's Encrypt.

Version precedence resolves toward local-only, but that leaves three unanswered
mechanics:
1. The API is Node/Fastify; Tauri is Rust. Shipping Node inside a Tauri installer
   means a **sidecar binary** — a real packaging decision affecting V3-1 and V3-3.
2. The Tauri auto-updater (v2 §10) needs a hosted manifest endpoint. With no VPS,
   there is no host.
3. `apps/station` is "served by the Manager machine" — so something must serve static
   assets over the LAN.

## R4 — SQLite single-writer under three concurrent clients

v3 §7.2 has the Agent and Station both holding persistent WebSockets and writing on
every captured invoice and card scan, plus the dashboard reading continuously.
SQLite permits one writer at a time. At one supermarket's volume this is very likely
fine, but it must be deliberate: enable **WAL mode**, set a **busy_timeout**, and keep
write transactions short. Not a blocker; a configuration requirement that is easy to
miss and painful to diagnose later.

## R5 — Fail-Open is a claim until it is tested

§4.6 and the process rules require that killing the agent never stops printing. Three
of the four capture modes (`VIRTUAL_PRINTER`, `SERIAL_BRIDGE`, `NETWORK_PROXY`) put the
agent **in the data path** — if it dies mid-job, the pass-through dies with it unless
each mode is explicitly designed to fail open (e.g. driver-level fallback, or the
bridge restoring the direct route on crash). `SPOOL_WATCH` is the only inherently
passive mode. This deserves design attention in V3-5, not just a test at the end.

## R6 — No real Al-Bayan print capture exists

The parsing pipeline (§4.5) and calibration mode (§4.7) are designed against an
unknown format. The `design/receipts/` fixture is my own reconstruction from Phase 1,
not real POS output. Calibration mode is the right mitigation and should be built
first-class, but the parser cannot be *verified* against reality until raw captured
bytes exist.

## R7 — Discarding the coupon engine loses ~570 tested lines

`coupon.service.ts` (143), `loyalty.service.ts` (233), `rules.service.ts` (178) plus
`coupons.test.ts` (302). This is correct per §1 and §2.1 — the business model changed
— but it is the largest single deletion in the migration and the atomic single-use
redemption logic in particular was carefully built. The **voucher** model (§5.2) needs
comparable single-use rigour; that reasoning should be carried across rather than
rewritten from scratch.

## R8 — Uncommitted work in the tree

14 uncommitted files including the reports layer (green, 10 tests) and the three v2/v3
spec documents. Should be committed before migration begins so the pivot has a clean
baseline to diff against.
