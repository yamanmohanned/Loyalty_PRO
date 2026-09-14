//! The licensing functions the API calls, in Rust.
//!
//! The API decides nothing about a licence by itself: it hands this module the stored
//! codes, the stored device ID and the clocks, and gets back a status that was
//! verified and evaluated here — on every check, not once at start-up.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use walaa_license::{
    anchors, best_license, clock_rolled_back, code, device, embedded_key_kind, embedded_public_key,
    embedded_unlock_chain, evaluate_all, key_fingerprint, recording_allowed_at, unlock, verify, Payload,
    VerifyError, KNOWN_FEATURES,
};

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

/// Every stored licence and emergency code, re-verified against the STORED device ID.
///
/// Not a fresh one: a replaced drive changes the computed ID, and the rule is to warn
/// about that, never to revoke.
struct Stored {
    licenses: Vec<Payload>,
    invalid_codes: u32,
    unlock_ends: Vec<i64>,
    invalid_unlocks: u32,
}

fn read_stored(codes: &[String], unlock_codes: &[String], device_id: &str) -> Stored {
    let mut stored = Stored { licenses: Vec::new(), invalid_codes: 0, unlock_ends: Vec::new(), invalid_unlocks: 0 };
    for text in codes {
        match verify(text, device_id) {
            Ok(verified) => stored.licenses.push(verified.payload),
            Err(_) => stored.invalid_codes += 1,
        }
    }
    let chain = embedded_unlock_chain();
    for text in unlock_codes {
        match unlock::read(text, device_id, &chain) {
            Ok(found) => stored.unlock_ends.push(found.valid_until),
            Err(_) => stored.invalid_unlocks += 1,
        }
    }
    stored
}

#[napi(object)]
pub struct LicenseStatus {
    /// UNLICENSED | TRIAL | EMERGENCY | GRACE | EXPIRED | PERPETUAL | TAMPERED
    pub status: String,
    pub read_only: bool,
    /// trial | perpetual | emergency — what a working status rests on.
    pub basis: Option<String>,
    /// none | notice | warning | urgent
    pub warning: String,
    /// The governing licence, when there is one.
    pub license: Option<LicenseInfo>,
    pub expires_at: Option<i64>,
    pub grace_ends_at: Option<i64>,
    pub days_left: Option<i64>,
    pub clock_behind_by: Option<i64>,
    /// Stored codes that failed their own check — the database was edited.
    pub invalid_codes: u32,
    pub invalid_unlocks: u32,
    /// The end of the latest emergency window entered here, past or future.
    pub emergency_until: Option<i64>,
    /// Seconds the system clock sits behind the latest recorded time — whatever the
    /// licence, so a rolled-back clock is recorded even where it changes nothing.
    pub clock_rollback_by: Option<i64>,
}

/// The status of this installation: every stored code re-verified, the governing
/// licence chosen, emergency codes applied over it, all against the clock and the
/// latest recorded time.
#[napi]
pub fn license_status(
    codes: Vec<String>,
    unlock_codes: Vec<String>,
    device_id: String,
    now: i64,
    latest_seen: Option<i64>,
) -> LicenseStatus {
    let stored = read_stored(&codes, &unlock_codes, &device_id);
    let governing = best_license(&stored.licenses);
    let evaluation = evaluate_all(governing, stored.invalid_codes > 0, &stored.unlock_ends, now, latest_seen);
    LicenseStatus {
        status: evaluation.status.as_str().to_string(),
        read_only: evaluation.status.read_only(),
        basis: evaluation.basis.map(|b| b.as_str().to_string()),
        warning: evaluation.warning.as_str().to_string(),
        license: governing.map(info),
        expires_at: evaluation.expires_at,
        grace_ends_at: evaluation.grace_ends_at,
        days_left: evaluation.days_left,
        clock_behind_by: evaluation.clock_behind_by,
        invalid_codes: stored.invalid_codes,
        invalid_unlocks: stored.invalid_unlocks,
        emergency_until: stored.unlock_ends.iter().copied().max(),
        clock_rollback_by: if clock_rolled_back(now, latest_seen) { latest_seen.map(|l| l - now) } else { None },
    }
}

#[napi(object)]
pub struct UnlockOutcome {
    pub ok: bool,
    /// MALFORMED | TYPO | NOT_VALID | EXPIRED
    pub reason: Option<String>,
    pub valid_until: Option<i64>,
    /// The code as the issuer prints it — what is stored.
    pub normalized: Option<String>,
}

/// Checks an emergency code typed from a phone call, for this device, against the
/// embedded chain. Its window is judged against the later of the two clocks.
#[napi]
pub fn verify_unlock(code: String, device_id: String, now: i64, latest_seen: Option<i64>) -> UnlockOutcome {
    let reference = latest_seen.map_or(now, |latest| latest.max(now));
    match unlock::verify(&code, &device_id, &embedded_unlock_chain(), reference) {
        Ok(found) => UnlockOutcome {
            ok: true,
            reason: None,
            valid_until: Some(found.valid_until),
            normalized: Some(found.normalized),
        },
        Err(error) => UnlockOutcome {
            ok: false,
            reason: Some(error.code().to_string()),
            valid_until: match error {
                unlock::UnlockError::Expired { valid_until } => Some(valid_until),
                _ => None,
            },
            normalized: None,
        },
    }
}

/// Whether recording was allowed at `t` — for a sale the till queued offline, judged by
/// when it happened rather than when it arrived.
#[napi]
pub fn recording_allowed(codes: Vec<String>, unlock_codes: Vec<String>, device_id: String, t: i64) -> bool {
    let stored = read_stored(&codes, &unlock_codes, &device_id);
    recording_allowed_at(&stored.licenses, &stored.unlock_ends, t)
}

/// Seconds since Windows started — evidence recorded with a clock event.
#[napi]
pub fn uptime_seconds() -> Option<i64> {
    #[cfg(windows)]
    {
        Some(walaa_license::windows::uptime_seconds() as i64)
    }
    #[cfg(not(windows))]
    {
        None
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
    /// The day the vendor's key was made. A system clock earlier than this cannot be
    /// right: it is how a dead CMOS battery is told apart from a clock set back.
    pub created_at: i64,
}

/// Which key this build trusts — the installer build refuses a development one.
#[napi]
pub fn key_info() -> KeyInfo {
    KeyInfo {
        kind: embedded_key_kind().as_str().to_string(),
        fingerprint: key_fingerprint(&embedded_public_key()),
        created_at: embedded_unlock_chain().created_at(),
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

/// Test build only: an emergency code from the published test chain.
#[cfg(feature = "test-key")]
#[napi]
pub fn unlock_code_for_tests(device_id: String, now: i64, days: u32) -> String {
    walaa_license::test_support::unlock_code(&device_id, now, days)
}

/// Test build only: removes a test registry key.
#[cfg(all(feature = "test-key", windows))]
#[napi]
pub fn delete_registry_key_for_tests(subkey: String) -> Result<()> {
    walaa_license::windows::delete_registry_key(&subkey).map_err(Error::from_reason)
}
