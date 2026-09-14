//! Building a licence payload from the command line's request.

use walaa_license::device::{is_valid_device_id, normalize_device_id};
use walaa_license::{LicenseKind, Payload, FORMAT_VERSION, KNOWN_FEATURES};

const DAY: i64 = 86_400;
pub const MAX_DAYS: u32 = 3650;
pub const DEFAULT_FEATURES: &[&str] = &["drive_backup", "multi_device"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Term {
    Days(u32),
    Perpetual,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub device: String,
    pub term: Term,
    /// Add the days to the device's latest trial expiry instead of to now.
    pub extend: bool,
    pub features: Option<Vec<String>>,
    pub note: Option<String>,
}

/// The payload for `request`, issued at `now`.
///
/// `previous_expiry` is the latest expiry this issuer has logged for the device — the
/// base an extension adds to. An extension of a trial that has already run out starts
/// from now: adding five days to a date three weeks ago would grant nothing.
pub fn build(request: &Request, now: i64, previous_expiry: Option<i64>, lid: String) -> Result<Payload, String> {
    let device = normalize_device_id(&request.device);
    if !is_valid_device_id(&device) {
        return Err(format!(
            "{:?} is not a device ID — it looks like WL-XXXX-XXXX and uses only the symbols 2-9 and A-Z without I, L, O, U",
            request.device
        ));
    }

    let mut features: Vec<String> = match &request.features {
        Some(list) => list.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect(),
        None => DEFAULT_FEATURES.iter().map(|f| (*f).to_string()).collect(),
    };
    features.sort();
    features.dedup();
    if let Some(unknown) = features.iter().find(|f| !KNOWN_FEATURES.contains(&f.as_str())) {
        return Err(format!("unknown feature {unknown:?}; known: {}", KNOWN_FEATURES.join(", ")));
    }

    let note = request.note.as_ref().map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if note.as_ref().is_some_and(|n| n.chars().count() > 120) {
        return Err("the note is longer than 120 characters".into());
    }

    let (kind, exp) = match request.term {
        Term::Perpetual => {
            if request.extend {
                return Err("--extend applies to trial days, not to a perpetual licence".into());
            }
            (LicenseKind::Perpetual, None)
        }
        Term::Days(days) => {
            if days == 0 || days > MAX_DAYS {
                return Err(format!("--days must be between 1 and {MAX_DAYS}"));
            }
            let base = if request.extend {
                let previous = previous_expiry.ok_or_else(|| {
                    format!("--extend: no trial has been issued to {device} in this issuer's log")
                })?;
                previous.max(now)
            } else {
                now
            };
            (LicenseKind::Trial, Some(base + i64::from(days) * DAY))
        }
    };

    let payload = Payload { v: FORMAT_VERSION, lid, did: device, kind, iat: now, exp, feat: features, note };
    if !payload.is_consistent() {
        return Err("internal error: the payload is not consistent".into());
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_789_400_000;

    fn request(term: Term, extend: bool) -> Request {
        Request { device: " wl-2345-6789 ".into(), term, extend, features: None, note: Some("سوبرماركت".into()) }
    }

    #[test]
    fn a_trial_runs_the_given_days_from_now() {
        let payload = build(&request(Term::Days(14), false), NOW, None, "id".into()).unwrap();
        assert_eq!(payload.did, "WL-2345-6789");
        assert_eq!(payload.kind, LicenseKind::Trial);
        assert_eq!(payload.exp, Some(NOW + 14 * DAY));
        assert_eq!(payload.feat, vec!["drive_backup", "multi_device"]);
    }

    #[test]
    fn a_perpetual_has_no_expiry() {
        let payload = build(&request(Term::Perpetual, false), NOW, None, "id".into()).unwrap();
        assert_eq!(payload.exp, None);
        assert!(build(&request(Term::Perpetual, true), NOW, None, "id".into()).is_err());
    }

    #[test]
    fn an_extension_adds_to_the_last_expiry_or_to_now_if_it_has_passed() {
        let running = build(&request(Term::Days(5), true), NOW, Some(NOW + 3 * DAY), "id".into()).unwrap();
        assert_eq!(running.exp, Some(NOW + 8 * DAY));
        let lapsed = build(&request(Term::Days(5), true), NOW, Some(NOW - 30 * DAY), "id".into()).unwrap();
        assert_eq!(lapsed.exp, Some(NOW + 5 * DAY));
        assert!(build(&request(Term::Days(5), true), NOW, None, "id".into()).is_err());
    }

    #[test]
    fn refuses_bad_input() {
        let mut bad_device = request(Term::Days(14), false);
        bad_device.device = "WL-ILOU-0000".into();
        assert!(build(&bad_device, NOW, None, "id".into()).is_err());

        let mut bad_feature = request(Term::Days(14), false);
        bad_feature.features = Some(vec!["drive_bakup".into()]);
        assert!(build(&bad_feature, NOW, None, "id".into()).is_err());

        assert!(build(&request(Term::Days(0), false), NOW, None, "id".into()).is_err());
    }
}
