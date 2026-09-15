// Written by `license-issuer keygen`. Do not edit by hand.
//
// Fingerprint FCA66207230B90CA. A development key runs and can be tested end to end, and
// `pnpm package:installer` refuses to package it (packaging/scripts/verify-license-key.mjs).

use crate::KeyKind;

pub const KEY_KIND: KeyKind = KeyKind::Production;

pub const PUBLIC_KEY: [u8; 32] = [
    0xd4, 0x66, 0x30, 0x66, 0x8a, 0x92, 0xc2, 0x69,
    0x83, 0xe6, 0x58, 0x7b, 0xcd, 0xbc, 0x36, 0x3f,
    0x6a, 0x51, 0x53, 0x0f, 0x44, 0x1c, 0x00, 0xaa,
    0xee, 0x2a, 0xac, 0x85, 0xad, 0x87, 0xdd, 0x2f,
];

// The emergency-code chain (crates/walaa-license/src/unlock.rs). Public values:
// phone codes are checked by hashing forward to this tip.
pub const UNLOCK_EPOCH_DAY: i64 = 20703;
pub const UNLOCK_CHAIN_LENGTH: u32 = 7300;
pub const UNLOCK_TIP: u64 = 0x297b71dd08afd8b5;
