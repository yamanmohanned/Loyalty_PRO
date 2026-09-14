//! Offline licensing for ولاء.
//!
//! One crate, used by two very different programs:
//!
//! * the **native module** the API loads (`packages/license-native`), which computes
//!   this machine's device ID, verifies license codes against the public key embedded
//!   here, evaluates the licence status and keeps the clock anchors; and
//! * the **issuer** (`tools/license-issuer`), which never ships and is the only thing
//!   that holds the private key. It uses this crate for the payload format and the
//!   device-ID rules, so the two cannot drift apart.
//!
//! The private key appears nowhere in this crate. What is here is public by design:
//! a signature scheme is only as strong as the private half, and the public half is
//! compiled into every installed copy anyway.

pub mod anchors;
pub mod code;
pub mod device;
pub mod payload;
// The test build embeds the test key instead, so there the vendor's key goes unused.
#[cfg_attr(feature = "test-key", allow(dead_code))]
mod public_key;
pub mod status;
pub mod verify;
#[cfg(windows)]
pub mod windows;
#[cfg(test)]
mod spec_tests;

pub use payload::{LicenseKind, Payload, FORMAT_VERSION};
pub use status::{best_license, evaluate, Evaluation, Status};
pub use verify::{verify, verify_with_key, Verified, VerifyError};

use sha2::{Digest, Sha256};

/// Features a license can grant. The issuer refuses any other name, so a typo cannot
/// produce a code that silently grants nothing.
pub const KNOWN_FEATURES: &[&str] = &["drive_backup", "multi_device"];

/// Which key is embedded in this build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    /// A key whose private half is not the vendor's. The installer build refuses it.
    Development,
    /// The vendor's key, written by `license-issuer keygen`.
    Production,
}

impl KeyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyKind::Development => "development",
            KeyKind::Production => "production",
        }
    }
}

/// The public key every license code is checked against.
pub fn embedded_public_key() -> [u8; 32] {
    #[cfg(feature = "test-key")]
    {
        test_support::test_public_key()
    }
    #[cfg(not(feature = "test-key"))]
    {
        public_key::PUBLIC_KEY
    }
}

/// Whether the embedded key is the vendor's.
pub fn embedded_key_kind() -> KeyKind {
    #[cfg(feature = "test-key")]
    {
        KeyKind::Development
    }
    #[cfg(not(feature = "test-key"))]
    {
        public_key::KEY_KIND
    }
}

/// A short public identifier for a key — safe to print and to compare by eye.
pub fn key_fingerprint(key: &[u8; 32]) -> String {
    let digest = Sha256::digest(key);
    digest[..8].iter().map(|b| format!("{b:02X}")).collect()
}

/// The published test key: its private half is in this source file, so nothing that
/// trusts it can ever be shipped. Used by the crate's own tests and by the native
/// module's test build, which the API's test suite loads.
#[cfg(any(test, feature = "test-key"))]
pub mod test_support {
    use crate::{code, Payload};
    use ed25519_dalek::{Signer, SigningKey};

    pub const TEST_SEED: [u8; 32] = [0x77; 32];

    pub fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_SEED)
    }

    pub fn test_public_key() -> [u8; 32] {
        test_signing_key().verifying_key().to_bytes()
    }

    /// A code for `payload`, signed with the test key.
    pub fn sign(payload: &Payload) -> String {
        sign_raw(&payload.to_bytes())
    }

    /// A code for arbitrary payload bytes — for tests that need a signed payload the
    /// format would never produce.
    pub fn sign_raw(bytes: &[u8]) -> String {
        let signature = test_signing_key().sign(bytes);
        code::encode(bytes, &signature.to_bytes())
    }
}
