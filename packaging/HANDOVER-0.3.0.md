# Handover — ولاء 0.3.0 (superseded)

**Superseded on 2026-09-17 by [`HANDOVER-0.3.1.md`](HANDOVER-0.3.1.md). Do not install 0.3.0 at a
shop** — its «ربط حساب Google» opens nothing, and its licence commands below have been replaced.

The 0.3.0 installer was `ولاء_0.3.0_x64-setup.exe`, 33,877,004 bytes, SHA-256
`68AE613ECC0C9A2CB677227F55769174359D6C5F3001F7C43C36A345D75EB12B`, built from `84f20cc`
(recorded in `RELEASING.md` §5). Its acceptance matrix, screen reachability table and strings
review are in git: `git show 1b7b32d:packaging/HANDOVER-0.3.0.md`.

The issuing commands this file used to carry piped `PASSWORD.txt` into the issuer
(`(Get-Content … -Raw).TrimEnd() | & …`). They still open the key, but they are **not** the
commands to use: a pipe in Windows PowerShell 5.1 turns any non-English character into `?`, and a
wrapper around them is how the renewal failed. Use `ON-SITE-CARD.md`, whose commands read the
password with `--password-file` and were each run as written on 2026-09-17.
