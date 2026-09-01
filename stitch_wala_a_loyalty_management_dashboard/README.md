# Stitch exports — read this before treating anything here as a specification

These screens were generated **before the v3 pivot** and describe the v1 product. Six of
the thirteen are screens for things v3 deliberately stopped building — the coupon
redemption flow, the four screens of the Expo assistant that no longer exists, and a
customer detail built around a coupon list — so following them literally walks the
product backwards, and `CLAUDE.md` §6's instruction to align implementation to these
exports no longer holds. **`CLAUDE_v3.md` §12.26 is the ruling that governs how they may
be used:** they are authoritative for layout and visual grammar only, on the four screens
that survive (Overview, Customers, Customer detail structure, and the dashboard Login);
their content model is discarded entirely, the Material-3 palette every export ships
contradicts the §6.2 tokens and must never be lifted verbatim, and where the exports
disagree with each other or with the implementation, the implementation wins. They are
kept in the repository because they are the reference those four screens were built
against and §12.26 cannot be checked without them — not because they describe what this
product is now.
