//! The licence status, from the licence and two clocks: the system's, and the latest
//! time this installation has ever recorded.

use crate::{LicenseKind, Payload};

/// Days a trial keeps working after it expires.
pub const GRACE_DAYS: i64 = 5;
/// Days before expiry from which the top bar counts down.
pub const WARNING_DAYS: i64 = 7;
/// How far the system clock may sit behind the latest recorded time before it counts
/// as rolled back. Generous enough for a time-zone or daylight-saving mistake.
pub const CLOCK_TOLERANCE_SECS: i64 = 2 * 3600;

const DAY: i64 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No licence. The state of a new installation.
    Unlicensed,
    Trial,
    /// The trial has expired and the grace days are running. Fully working.
    TrialGrace,
    /// Trial and grace both over.
    Expired,
    /// Never expires; time is not consulted.
    Perpetual,
    /// The clock is behind the latest recorded time, or the stored licence failed its
    /// own signature check.
    Tampered,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Unlicensed => "UNLICENSED",
            Status::Trial => "TRIAL",
            Status::TrialGrace => "TRIAL_GRACE",
            Status::Expired => "EXPIRED",
            Status::Perpetual => "PERPETUAL",
            Status::Tampered => "TAMPERED",
        }
    }

    /// Read-only: reports, customers, backups and restores keep working; new sales,
    /// new customers and voucher redemptions are refused.
    pub fn read_only(self) -> bool {
        matches!(self, Status::Unlicensed | Status::Expired | Status::Tampered)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub status: Status,
    pub expires_at: Option<i64>,
    pub grace_ends_at: Option<i64>,
    /// Whole days left — until expiry in TRIAL, until the grace ends in TRIAL_GRACE.
    pub days_left: Option<i64>,
    /// TRIAL within its last seven days.
    pub show_expiry_warning: bool,
    /// Seconds the clock sits behind the latest recorded time, when TAMPERED by clock.
    pub clock_behind_by: Option<i64>,
}

impl Evaluation {
    fn plain(status: Status) -> Self {
        Evaluation {
            status,
            expires_at: None,
            grace_ends_at: None,
            days_left: None,
            show_expiry_warning: false,
            clock_behind_by: None,
        }
    }
}

/// The licence that governs, out of every code ever activated on this installation.
///
/// A perpetual licence wins outright; otherwise the trial that expires last. So an
/// extension takes effect by being activated, and activating an older code again —
/// by mistake, or on purpose — can never shorten what the shop already has.
pub fn best_license(licenses: &[Payload]) -> Option<&Payload> {
    licenses
        .iter()
        .find(|l| l.kind == LicenseKind::Perpetual)
        .or_else(|| licenses.iter().max_by_key(|l| l.exp.unwrap_or(l.iat)))
}

/// Whether `now` sits more than the tolerance behind `latest_seen`.
pub fn clock_rolled_back(now: i64, latest_seen: Option<i64>) -> bool {
    latest_seen.is_some_and(|latest| now + CLOCK_TOLERANCE_SECS < latest)
}

fn ceil_days(seconds: i64) -> i64 {
    (seconds + DAY - 1) / DAY
}

/// The status of `license` at `now`, given the latest time ever recorded here.
///
/// For a trial, the licence's own issue time is one more anchor: a machine whose clock
/// reads earlier than the moment the vendor issued its code has been set back.
pub fn evaluate(license: Option<&Payload>, now: i64, latest_seen: Option<i64>) -> Evaluation {
    let Some(license) = license else {
        return Evaluation::plain(Status::Unlicensed);
    };

    if license.kind == LicenseKind::Perpetual {
        return Evaluation::plain(Status::Perpetual);
    }

    let expires_at = license.exp.unwrap_or(license.iat);
    let grace_ends_at = expires_at + GRACE_DAYS * DAY;
    let reference = latest_seen.max(Some(license.iat));

    if clock_rolled_back(now, reference) {
        return Evaluation {
            status: Status::Tampered,
            expires_at: Some(expires_at),
            grace_ends_at: Some(grace_ends_at),
            days_left: None,
            show_expiry_warning: false,
            clock_behind_by: reference.map(|r| r - now),
        };
    }

    if now < expires_at {
        let days_left = ceil_days(expires_at - now);
        return Evaluation {
            status: Status::Trial,
            expires_at: Some(expires_at),
            grace_ends_at: Some(grace_ends_at),
            days_left: Some(days_left),
            show_expiry_warning: days_left <= WARNING_DAYS,
            clock_behind_by: None,
        };
    }

    if now < grace_ends_at {
        return Evaluation {
            status: Status::TrialGrace,
            expires_at: Some(expires_at),
            grace_ends_at: Some(grace_ends_at),
            days_left: Some(ceil_days(grace_ends_at - now)),
            show_expiry_warning: true,
            clock_behind_by: None,
        };
    }

    Evaluation {
        status: Status::Expired,
        expires_at: Some(expires_at),
        grace_ends_at: Some(grace_ends_at),
        days_left: Some(0),
        show_expiry_warning: false,
        clock_behind_by: None,
    }
}
