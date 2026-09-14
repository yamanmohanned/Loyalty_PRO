//! The cases the licensing spec names, end to end through the public API.
//!
//! A unit-test module rather than `tests/`: the test key lives behind `cfg(test)`, and
//! an integration test cannot see it without a feature a plain `cargo test` would skip.
//!
//! Signed with the crate's published test key (`test_support`), verified with
//! `verify_with_key` against its public half — so these prove the format, the checks
//! and the status rules without the vendor's key.

use crate::code::{self, wrap};
use crate::status::{clock_rolled_back, CLOCK_TOLERANCE_SECS, GRACE_DAYS};
use crate::test_support::{sign, sign_raw, test_public_key};
use crate::{anchors, device, evaluate, verify_with_key, LicenseKind, Payload, Status, VerifyError};

const DAY: i64 = 86_400;
const NOW: i64 = 1_789_400_000; // 2026-09-14

fn device() -> String {
    device::device_id("4c4c4544-0042-3510-8052-b4c04f4d4a32", 0x1A2B_3C4D)
}

fn trial(days: i64) -> Payload {
    Payload {
        v: 1,
        lid: "0d7c6f1e-7a3b-4b59-9a8e-2f64c1c0a111".into(),
        did: device(),
        kind: LicenseKind::Trial,
        iat: NOW,
        exp: Some(NOW + days * DAY),
        feat: vec!["drive_backup".into()],
        note: Some("سوبرماركت النخبة".into()),
    }
}

fn perpetual() -> Payload {
    Payload { kind: LicenseKind::Perpetual, exp: None, ..trial(0) }
}

fn check(code: &str) -> Result<Payload, VerifyError> {
    verify_with_key(code, &device(), &test_public_key()).map(|v| v.payload)
}

#[test]
fn a_valid_signature_is_accepted() {
    let payload = trial(14);
    assert_eq!(check(&sign(&payload)).unwrap(), payload);
}

#[test]
fn an_altered_payload_fails_its_signature() {
    let code = sign(&trial(14));
    // Change one character inside the payload half.
    let mut bytes = code.into_bytes();
    bytes[10] = if bytes[10] == b'A' { b'B' } else { b'A' };
    assert_eq!(check(&String::from_utf8(bytes).unwrap()), Err(VerifyError::BadSignature));
}

#[test]
fn a_code_signed_by_another_key_is_refused() {
    let code = sign(&trial(14));
    let other = ed25519_other_key();
    assert_eq!(verify_with_key(&code, &device(), &other).map(|v| v.payload), Err(VerifyError::BadSignature));
}

fn ed25519_other_key() -> [u8; 32] {
    // A valid curve point that is not the test key: the public half of another seed.
    let signing = ed25519_dalek::SigningKey::from_bytes(&[0x11; 32]);
    signing.verifying_key().to_bytes()
}

#[test]
fn a_code_for_another_device_is_refused_and_names_that_device() {
    let mut payload = trial(14);
    payload.did = device::device_id("another-machine", 7);
    assert_eq!(check(&sign(&payload)), Err(VerifyError::DeviceMismatch { licensed: payload.did.clone() }));
}

#[test]
fn a_corrupted_code_is_malformed_not_a_signature_failure() {
    assert_eq!(check("garbage"), Err(VerifyError::Malformed));
    assert_eq!(check(""), Err(VerifyError::Malformed));
    let code = sign(&trial(14));
    assert_eq!(check(&code[..code.len() - 5]), Err(VerifyError::Malformed));
    // Signed, but not JSON — only a hand-made code can be this.
    assert_eq!(check(&sign_raw(b"not json")), Err(VerifyError::Malformed));
    // Signed JSON that contradicts itself: a trial with no expiry.
    let broken = br#"{"v":1,"lid":"x","did":"WL-2345-6789","type":"trial","iat":1,"exp":null,"feat":[]}"#;
    assert_eq!(check(&sign_raw(broken)), Err(VerifyError::Malformed));
}

#[test]
fn an_unsupported_version_is_its_own_refusal() {
    let future = format!(
        r#"{{"v":2,"lid":"x","did":"{}","type":"perpetual","iat":1,"exp":null,"feat":[]}}"#,
        device()
    );
    assert_eq!(check(&sign_raw(future.as_bytes())), Err(VerifyError::UnsupportedVersion(2)));
}

#[test]
fn a_pasted_code_with_spaces_and_line_breaks_is_accepted() {
    let payload = trial(14);
    let code = sign(&payload);
    let wrapped = wrap(&code);
    assert!(wrapped.lines().all(|line| line.len() <= code::LINE_WIDTH));

    // As WhatsApp delivers it in an Arabic chat: CRLF, stray spaces, direction marks.
    let pasted = format!("  \u{200F}{}\u{200E}\r\n\t", wrapped.replace('\n', " \r\n ").replace("AA", "A A"));
    assert_eq!(check(&pasted).unwrap(), payload);
}

#[test]
fn the_payload_is_the_spec_json_in_the_spec_order() {
    let json = String::from_utf8(perpetual().to_bytes()).unwrap();
    assert!(json.starts_with(r#"{"v":1,"lid":"#), "{json}");
    assert!(json.contains(r#""type":"perpetual","iat":1789400000,"exp":null,"feat":["drive_backup"]"#), "{json}");
}

#[test]
fn a_running_trial_counts_down_and_warns_in_its_last_week() {
    let payload = trial(14);
    let early = evaluate(Some(&payload), NOW + DAY, Some(NOW));
    assert_eq!(early.status, Status::Trial);
    assert_eq!(early.days_left, Some(13));
    assert!(!early.show_expiry_warning);

    let late = evaluate(Some(&payload), NOW + 8 * DAY, Some(NOW + 8 * DAY));
    assert_eq!(late.status, Status::Trial);
    assert_eq!(late.days_left, Some(6));
    assert!(late.show_expiry_warning);
}

#[test]
fn an_expired_trial_has_five_working_days_then_goes_read_only() {
    let payload = trial(14);
    let grace = evaluate(Some(&payload), NOW + 15 * DAY, Some(NOW + 15 * DAY));
    assert_eq!(grace.status, Status::TrialGrace);
    assert!(!grace.status.read_only());
    assert_eq!(grace.days_left, Some(GRACE_DAYS - 1));

    let expired = evaluate(Some(&payload), NOW + (14 + GRACE_DAYS) * DAY, Some(NOW + 19 * DAY));
    assert_eq!(expired.status, Status::Expired);
    assert!(expired.status.read_only());
}

#[test]
fn a_perpetual_license_never_expires_and_ignores_the_clock() {
    let payload = perpetual();
    for now in [NOW, NOW + 3650 * DAY, NOW - 3650 * DAY] {
        let evaluation = evaluate(Some(&payload), now, Some(NOW + 10 * DAY));
        assert_eq!(evaluation.status, Status::Perpetual);
        assert_eq!(evaluation.expires_at, None);
        assert!(!evaluation.status.read_only());
    }
}

#[test]
fn no_license_is_read_only() {
    let evaluation = evaluate(None, NOW, None);
    assert_eq!(evaluation.status, Status::Unlicensed);
    assert!(evaluation.status.read_only());
}

#[test]
fn setting_the_clock_back_is_tampering_and_clears_once_it_is_fixed() {
    let payload = trial(14);
    let latest_seen = NOW + 5 * DAY;

    // Two hours of slack for a time-zone mistake…
    let slack = evaluate(Some(&payload), latest_seen - CLOCK_TOLERANCE_SECS + 60, Some(latest_seen));
    assert_eq!(slack.status, Status::Trial);

    // …but a day back is a rollback.
    let rolled_back = evaluate(Some(&payload), latest_seen - DAY, Some(latest_seen));
    assert_eq!(rolled_back.status, Status::Tampered);
    assert!(rolled_back.status.read_only());
    assert_eq!(rolled_back.clock_behind_by, Some(DAY));

    // Corrected clock: the licence status comes straight back.
    let fixed = evaluate(Some(&payload), latest_seen + 60, Some(latest_seen));
    assert_eq!(fixed.status, Status::Trial);
}

#[test]
fn a_clock_earlier_than_the_codes_own_issue_time_is_tampering() {
    let payload = trial(14);
    assert!(clock_rolled_back(NOW - DAY, Some(NOW)));
    assert_eq!(evaluate(Some(&payload), NOW - DAY, None).status, Status::Tampered);
}

#[test]
fn an_extension_governs_and_an_older_code_cannot_shorten_it() {
    let first = trial(14);
    let extension = Payload { lid: "ext".into(), exp: Some(NOW + 19 * DAY), ..trial(14) };
    let reactivated_old = first.clone();
    let all = [first, extension.clone(), reactivated_old];
    assert_eq!(crate::best_license(&all), Some(&extension));

    let with_perpetual = [trial(30), perpetual(), trial(60)];
    assert_eq!(crate::best_license(&with_perpetual).map(|l| l.kind), Some(LicenseKind::Perpetual));
    assert_eq!(crate::best_license(&[]), None);
}

#[test]
fn conflicting_anchors_resolve_to_the_most_restrictive_and_are_reported() {
    // Database, registry, file — the file was deleted and the registry edited back.
    let resolution = anchors::resolve(&[Some(NOW + 5 * DAY), Some(NOW), None]);
    assert!(resolution.conflict);
    assert_eq!(resolution.latest, Some(NOW + 5 * DAY));

    let payload = trial(14);
    let evaluation = evaluate(Some(&payload), NOW + DAY, resolution.latest);
    assert_eq!(evaluation.status, Status::Tampered);
}
