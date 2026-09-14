//! Checking a pasted code: format, signature, version, device — in that order, each
//! with its own refusal.

use ed25519_dalek::{Signature, VerifyingKey};

use crate::code::{self, normalize};
use crate::device::normalize_device_id;
use crate::payload::{Payload, FORMAT_VERSION};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// Not the format at all: no separator, bad Base64, wrong signature length, or a
    /// payload that is not a consistent licence.
    Malformed,
    /// The signature does not match the payload under the embedded key — a code
    /// altered after issue, copied incompletely, or not issued by the vendor.
    BadSignature,
    /// Signed by the vendor, in a payload version this build does not read.
    UnsupportedVersion(u64),
    /// Genuine, but for another device.
    DeviceMismatch { licensed: String },
}

impl VerifyError {
    pub fn code(&self) -> &'static str {
        match self {
            VerifyError::Malformed => "MALFORMED",
            VerifyError::BadSignature => "BAD_SIGNATURE",
            VerifyError::UnsupportedVersion(_) => "UNSUPPORTED_VERSION",
            VerifyError::DeviceMismatch { .. } => "DEVICE_MISMATCH",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Verified {
    pub payload: Payload,
    /// The code without whitespace — what is stored and re-checked.
    pub normalized: String,
}

/// Verifies `code` for `device` against the key embedded in this build.
pub fn verify(code: &str, device: &str) -> Result<Verified, VerifyError> {
    verify_with_key(code, device, &crate::embedded_public_key())
}

/// Verifies `code` for `device` against `key`.
///
/// The signature is checked before the payload is parsed, so nothing unsigned is ever
/// interpreted. The version is read only after the signature holds: a future format
/// from the vendor is "update the program", not "this code is fake".
pub fn verify_with_key(code: &str, device: &str, key: &[u8; 32]) -> Result<Verified, VerifyError> {
    let normalized = normalize(code);
    let parts = code::decode(&normalized).ok_or(VerifyError::Malformed)?;

    let verifying_key = VerifyingKey::from_bytes(key).map_err(|_| VerifyError::BadSignature)?;
    let signature = Signature::from_bytes(&parts.signature);
    verifying_key
        .verify_strict(&parts.payload, &signature)
        .map_err(|_| VerifyError::BadSignature)?;

    let value: serde_json::Value =
        serde_json::from_slice(&parts.payload).map_err(|_| VerifyError::Malformed)?;
    let version = value.get("v").and_then(serde_json::Value::as_u64).ok_or(VerifyError::Malformed)?;
    if version != u64::from(FORMAT_VERSION) {
        return Err(VerifyError::UnsupportedVersion(version));
    }

    let payload: Payload = serde_json::from_value(value).map_err(|_| VerifyError::Malformed)?;
    if !payload.is_consistent() {
        return Err(VerifyError::Malformed);
    }

    if payload.did != normalize_device_id(device) {
        return Err(VerifyError::DeviceMismatch { licensed: payload.did.clone() });
    }

    Ok(Verified { payload, normalized })
}
