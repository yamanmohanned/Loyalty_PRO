//! The signed payload: `{"v":1,"lid":…,"did":…,"type":…,"iat":…,"exp":…,"feat":[…],"note":…}`.

use serde::{Deserialize, Serialize};

use crate::device;

/// The only payload version this build understands.
pub const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseKind {
    Trial,
    Perpetual,
}

impl LicenseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LicenseKind::Trial => "trial",
            LicenseKind::Perpetual => "perpetual",
        }
    }
}

/// Field order here is the order in the JSON, which is the order the spec gives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub v: u32,
    /// The license id — a UUID the issuer generates and logs.
    pub lid: String,
    /// The device this code is for, `WL-XXXX-XXXX`.
    pub did: String,
    #[serde(rename = "type")]
    pub kind: LicenseKind,
    /// Issued at, unix seconds, by the issuer's clock.
    pub iat: i64,
    /// Expires at, unix seconds; `null` for a perpetual license.
    pub exp: Option<i64>,
    #[serde(default)]
    pub feat: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Payload {
    /// The exact bytes that are signed: compact JSON, no whitespace.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a payload always serialises")
    }

    /// Internal consistency — a payload that contradicts itself is treated as corrupt.
    ///
    /// A trial has an expiry after its issue time; a perpetual has none. Only the
    /// issuer produces payloads, so a failure here means a damaged or hand-made code.
    pub fn is_consistent(&self) -> bool {
        let times = match self.kind {
            LicenseKind::Trial => self.exp.is_some_and(|exp| exp > self.iat),
            LicenseKind::Perpetual => self.exp.is_none(),
        };
        times
            && !self.lid.is_empty()
            && self.lid.len() <= 64
            && device::is_valid_device_id(&self.did)
            && self.feat.len() <= 32
            && self.feat.iter().all(|f| !f.is_empty() && f.len() <= 40)
            && self.note.as_ref().is_none_or(|n| n.chars().count() <= 120)
    }

    pub fn has_feature(&self, name: &str) -> bool {
        self.feat.iter().any(|f| f == name)
    }
}
