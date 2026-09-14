// Written by `license-issuer keygen`. Do not edit by hand.
//
// Fingerprint 49C862E0D57E50B7. A development key runs and can be tested end to end, and
// `pnpm package:installer` refuses to package it (packaging/scripts/verify-license-key.mjs).

use crate::KeyKind;

pub const KEY_KIND: KeyKind = KeyKind::Development;

pub const PUBLIC_KEY: [u8; 32] = [
    0x9d, 0xa0, 0x0e, 0x89, 0x09, 0xd7, 0x30, 0x51,
    0x25, 0xb2, 0x30, 0xb5, 0x1d, 0xe5, 0x9c, 0xf5,
    0x91, 0xda, 0x4b, 0x70, 0xdb, 0x73, 0x9c, 0x0f,
    0x56, 0x62, 0x2b, 0xb6, 0x9c, 0x0f, 0x77, 0x04,
];

// The emergency-code chain (crates/walaa-license/src/unlock.rs). Public values:
// phone codes are checked by hashing forward to this tip.
pub const UNLOCK_EPOCH_DAY: i64 = 20702;
pub const UNLOCK_CHAIN_LENGTH: u32 = 7300;
pub const UNLOCK_TIP: u64 = 0x5aab66da129491c1;
