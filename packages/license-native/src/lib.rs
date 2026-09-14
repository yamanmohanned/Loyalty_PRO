//! The licensing functions the API calls, in Rust.
//!
//! The API decides nothing about a licence by itself: it hands this module the stored
//! codes, the stored device ID and the clocks, and gets back a status that was
//! verified and evaluated here — on every check, not once at start-up.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use walaa_license::{anchors, best_license, code, device, embedded_key_kind, embedded_public_key, evaluate,
    key_fingerprint, verify, Payload, Status, VerifyError, KNOWN_FEATURES};

#[napi(object)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub machine_guid_digest: String,
    pub volume_serial_digest: String,
}

/// This machine's device ID, from MachineGuid and the system volume's serial.
#[napi]
pub fn compute_device_id() -> Result<DeviceIdentity> {
    #[cfg(windows)]
    {
        let guid = walaa_license::windows::machine_guid().map_err(Error::from_reason)?;
        let serial = walaa_license::windows::system_volume_serial().map_err(Error::from_reason)?;
        Ok(DeviceIdentity {
            device_id: device::device_id(&guid, serial),
            machine_guid_digest: device::source_digest("machine_guid", &guid.trim().to_ascii_lowercase()),
            volume_serial_digest: device::source_digest("volume_serial", &format!("{serial:08X}")),
        })
    }
    #[cfg(not(windows))]
    {
        Err(Error::from_reason("the device ID is computed on Windows only"))
    }
}

#[napi(object)]
pub struct LicenseInfo {
    pub license_id: String,
    pub device_id: String,
    pub kind: String,
    pub issued_at: i64,
    pub expires_at: Option<i64>,
    pub features: Vec<String>,
    pub note: Option<String>,
}

fn info(payload: &Payload) -> LicenseInfo {
    LicenseInfo {
        license_id: payload.lid.clone(),
        device_id: payload.did.clone(),
        kind: payload.kind.as_str().to_string(),
        issued_at: payload.iat,
        expires_at: payload.exp,
        features: payload.feat.clone(),
        note: payload.note.clone(),
    }
}

#[napi(object)]
pub struct VerifyOutcome {
    pub ok: bool,
    /// MALFORMED | BAD_SIGNATURE | UNSUPPORTED_VERSION | DEVICE_MISMATCH
    pub reason: Option<String>,
    /// For DEVICE_MISMATCH: the device the code was issued to.
    pub licensed_device: Option<String>,
    /// For UNSUPPORTED_VERSION: the version the code carries.
    pub version: Option<u32>,
    pub license: Option<LicenseInfo>,
    /// The code without whitespace — what is stored.
    pub normalized: Option<String>,
}

/// Checks a pasted code for this device against the embedded key.
#[napi]
pub fn verify_license(code: String, device_id: String) -> VerifyOutcome {
    match verify(&code, &device_id) {
        Ok(verified) => VerifyOutcome {
            ok: true,
            reason: None,
            licensed_device: None,
            version: None,
            license: Some(info(&verified.payload)),
            normalized: Some(verified.normalized),
        },
        Err(error) => VerifyOutcome {
            ok: false,
            reason: Some(error.code().to_string()),
            licensed_device: match &error {
                VerifyError::DeviceMismatch { licensed } => Some(licensed.clone()),
                _ => None,
            },
            version: match error {
                VerifyError::UnsupportedVersion(v) => Some(v.min(u64::from(u32::MAX)) as u32),
                _ => None,
            },
            license: None,
            normalized: None,
        },
    }
}

#[napi(object)]
pub struct LicenseStatus {
    /// UNLICENSED | TRIAL | TRIAL_GRACE | EXPIRED | PERPETUAL | TAMPERED
    pub status: String,
    pub read_only: bool,
    /// The governing licence, when there is one.
    pub license: Option<LicenseInfo>,
    pub expires_at: Option<i64>,
    pub grace_ends_at: Option<i64>,
    pub days_left: Option<i64>,
    pub show_expiry_warning: bool,
    pub clock_behind_by: Option<i64>,
    /// Stored codes that failed their own check — the database was edited.
    pub invalid_codes: u32,
}

/// The status of this installation: every stored code re-verified, the governing one
/// chosen, and evaluated against the clock and the latest recorded time.
///
/// Stored codes are verified against the STORED device ID, not a fresh one: a replaced
/// drive changes the computed ID, and the rule is to warn about that, not to revoke.
#[napi]
pub fn license_status(codes: Vec<String>, device_id: String, now: i64, latest_seen: Option<i64>) -> LicenseStatus {
    let mut valid = Vec::new();
    let mut invalid_codes = 0u32;
    for stored in &codes {
        match verify(stored, &device_id) {
            Ok(verified) => valid.push(verified.payload),
            Err(_) => invalid_codes += 1,
        }
    }

    let governing = best_license(&valid);
    if governing.is_none() && invalid_codes > 0 {
        return LicenseStatus {
            status: Status::Tampered.as_str().to_string(),
            read_only: true,
            license: None,
            expires_at: None,
            grace_ends_at: None,
            days_left: None,
            show_expiry_warning: false,
            clock_behind_by: None,
            invalid_codes,
        };
    }

    let evaluation = evaluate(governing, now, latest_seen);
    LicenseStatus {
        status: evaluation.status.as_str().to_string(),
        read_only: evaluation.status.read_only(),
        license: governing.map(info),
        expires_at: evaluation.expires_at,
        grace_ends_at: evaluation.grace_ends_at,
        days_left: evaluation.days_left,
        show_expiry_warning: evaluation.show_expiry_warning,
        clock_behind_by: evaluation.clock_behind_by,
        invalid_codes,
    }
}

#[napi(object)]
pub struct AnchorResolution {
    pub latest: Option<i64>,
    pub conflict: bool,
}

/// The latest of the recorded times, and whether the locations disagreed.
#[napi]
pub fn resolve_anchors(readings: Vec<Option<i64>>) -> AnchorResolution {
    let resolution = anchors::resolve(&readings);
    AnchorResolution { latest: resolution.latest, conflict: resolution.conflict }
}

#[napi]
pub fn read_file_anchor(path: String) -> Result<Option<i64>> {
    anchors::read_file(std::path::Path::new(&path)).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn write_file_anchor(path: String, value: i64) -> Result<()> {
    anchors::write_file(std::path::Path::new(&path), value).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn read_registry_anchor(subkey: String) -> Result<Option<i64>> {
    #[cfg(windows)]
    {
        walaa_license::windows::read_registry_anchor(&subkey).map_err(Error::from_reason)
    }
    #[cfg(not(windows))]
    {
        let _ = subkey;
        Ok(None)
    }
}

#[napi]
pub fn write_registry_anchor(subkey: String, value: i64) -> Result<()> {
    #[cfg(windows)]
    {
        walaa_license::windows::write_registry_anchor(&subkey, value).map_err(Error::from_reason)
    }
    #[cfg(not(windows))]
    {
        let _ = (subkey, value);
        Ok(())
    }
}

#[napi(object)]
pub struct KeyInfo {
    /// development | production
    pub kind: String,
    pub fingerprint: String,
}

/// Which key this build trusts — the installer build refuses a development one.
#[napi]
pub fn key_info() -> KeyInfo {
    KeyInfo {
        kind: embedded_key_kind().as_str().to_string(),
        fingerprint: key_fingerprint(&embedded_public_key()),
    }
}

/// A pasted code with whitespace and invisible marks removed.
#[napi]
pub fn normalize_code(text: String) -> String {
    code::normalize(&text)
}

#[napi]
pub fn known_features() -> Vec<String> {
    KNOWN_FEATURES.iter().map(|f| (*f).to_string()).collect()
}

/// Test build only: signs arbitrary payload JSON with the published test key.
#[cfg(feature = "test-key")]
#[napi]
pub fn sign_for_tests(payload_json: String) -> String {
    walaa_license::test_support::sign_raw(payload_json.as_bytes())
}

/// Test build only: removes a test registry key.
#[cfg(all(feature = "test-key", windows))]
#[napi]
pub fn delete_registry_key_for_tests(subkey: String) -> Result<()> {
    walaa_license::windows::delete_registry_key(&subkey).map_err(Error::from_reason)
}
