//! Building a licence payload from the command line's request.

use loyalty_pro_license::device::{is_valid_device_id, normalize_device_id};
use loyalty_pro_license::{LicenseKind, Payload, FORMAT_VERSION, KNOWN_FEATURES};

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
    /// Add the days to the device's latest trial expiry instead of to now. Set by `renew`.
    pub extend: bool,
    pub features: Option<Vec<String>>,
    pub note: Option<String>,
}

/// What this issuer's log says a device already holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Current {
    /// The latest end of any trial issued to it.
    pub trial_until: Option<i64>,
    /// When a perpetual licence was issued to it, if one was.
    pub perpetual_since: Option<i64>,
    /// The features and note of the most recent licence, which a renewal carries forward.
    pub features: Vec<String>,
    pub note: Option<String>,
}

impl Current {
    /// Summarises a device's log entries, oldest first as `log::list` returns them.
    pub fn from_entries(entries: &[crate::log::Entry]) -> Option<Current> {
        let latest = entries.last()?;
        Some(Current {
            trial_until: entries.iter().filter(|e| e.kind == "trial").filter_map(|e| e.expires_at).max(),
            perpetual_since: entries.iter().find(|e| e.kind == "perpetual").map(|e| e.issued_at),
            features: latest.features.split(',').map(str::trim).filter(|f| !f.is_empty()).map(String::from).collect(),
            note: latest.note.clone(),
        })
    }
}

/// `issue` is for a device's first licence. A device that already has one is renewed,
/// so a code that ends before the one the shop holds — and so changes nothing on its PC —
/// cannot be produced by using the wrong command.
pub fn refuse_if_already_licensed(device: &str, current: Option<&Current>) -> Result<(), String> {
    match current {
        None => Ok(()),
        Some(current) if current.perpetual_since.is_some() => Err(format!(
            "{device} already holds a perpetual licence in this log — it never expires, so there is nothing to issue. \
             `list --device {device}` shows its code, to send again."
        )),
        Some(_) => Err(format!(
            "{device} already has a licence in this log. To extend it or make it perpetual use `renew` \
             (renew --device {device} --days N, or renew --device {device} --perpetual) — it builds on the licence the shop holds."
        )),
    }
}

/// The request a renewal makes: days added to the end of the current licence (or to now,
/// if it has ended), or a perpetual licence; features and note carried forward unless given.
pub fn renewal(device: &str, term: Term, features: Option<Vec<String>>, note: Option<String>, current: Option<&Current>) -> Result<Request, String> {
    let Some(current) = current else {
        return Err(format!(
            "{device} has no licence in this issuer's log, so there is nothing to renew. A first licence is `issue`. \
             If it was issued from another copy of the key folder, pass that folder with --home."
        ));
    };
    if let Some(since) = current.perpetual_since {
        return Err(format!(
            "{device} has held a perpetual licence since {} — it never expires, so there is nothing to renew. \
             If the shop lost the code, `list --device {device}` shows it to send again.",
            crate::date(since)
        ));
    }
    Ok(Request {
        device: device.to_string(),
        extend: matches!(term, Term::Days(_)),
        term,
        features: features.or_else(|| Some(current.features.clone())),
        note: note.or_else(|| current.note.clone()),
    })
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
                return Err("days are added to a trial, not to a perpetual licence".into());
            }
            (LicenseKind::Perpetual, None)
        }
        Term::Days(days) => {
            if days == 0 || days > MAX_DAYS {
                return Err(format!("--days must be between 1 and {MAX_DAYS}"));
            }
            let base = if request.extend {
                let previous = previous_expiry
                    .ok_or_else(|| format!("no trial has been issued to {device} in this issuer's log, so there are no days to add to"))?;
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

    fn current(trial_until: Option<i64>, perpetual_since: Option<i64>) -> Current {
        Current { trial_until, perpetual_since, features: vec!["drive_backup".into()], note: Some("سوبرماركت".into()) }
    }

    #[test]
    fn a_renewal_adds_days_to_a_running_licence() {
        let held = current(Some(NOW + 20 * DAY), None);
        let request = renewal("WL-2345-6789", Term::Days(30), None, None, Some(&held)).unwrap();
        let payload = build(&request, NOW, held.trial_until, "id".into()).unwrap();
        assert_eq!(payload.exp, Some(NOW + 50 * DAY));
        // Carried forward from the licence the shop holds.
        assert_eq!(payload.feat, vec!["drive_backup"]);
        assert_eq!(payload.note.as_deref(), Some("سوبرماركت"));
    }

    #[test]
    fn a_renewal_of_an_ended_licence_runs_from_now() {
        let held = current(Some(NOW - 40 * DAY), None);
        let request = renewal("WL-2345-6789", Term::Days(30), None, Some("new note".into()), Some(&held)).unwrap();
        let payload = build(&request, NOW, held.trial_until, "id".into()).unwrap();
        assert_eq!(payload.exp, Some(NOW + 30 * DAY));
        assert_eq!(payload.note.as_deref(), Some("new note"));
    }

    #[test]
    fn a_renewal_can_make_a_trial_perpetual() {
        let held = current(Some(NOW + 3 * DAY), None);
        let request = renewal("WL-2345-6789", Term::Perpetual, None, None, Some(&held)).unwrap();
        let payload = build(&request, NOW, held.trial_until, "id".into()).unwrap();
        assert_eq!(payload.kind, LicenseKind::Perpetual);
        assert_eq!(payload.exp, None);
    }

    #[test]
    fn renew_and_issue_each_refuse_the_other_ones_case() {
        // Nothing to renew.
        assert!(renewal("WL-2345-6789", Term::Days(30), None, None, None).is_err());
        // Perpetual: nothing to renew, nothing to issue.
        let paid = current(Some(NOW), Some(NOW - DAY));
        assert!(renewal("WL-2345-6789", Term::Days(30), None, None, Some(&paid)).is_err());
        assert!(refuse_if_already_licensed("WL-2345-6789", Some(&paid)).is_err());
        // A licensed device is renewed, not issued a code that may end sooner.
        assert!(refuse_if_already_licensed("WL-2345-6789", Some(&current(Some(NOW + DAY), None))).is_err());
        assert!(refuse_if_already_licensed("WL-2345-6789", None).is_ok());
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
