//! The licence status, from the licences, any emergency unlocks, and two clocks: the
//! system's, and the latest time this installation has ever recorded.

use crate::{LicenseKind, Payload};

/// Days of full operation after any time-limited entitlement ends — a trial or an
/// emergency window. Not a hard stop at midnight: five more days, with a red warning.
pub const GRACE_DAYS: i64 = 5;
/// From this many days before a trial ends, the bell carries a notice.
pub const NOTICE_DAYS: i64 = 14;
/// From this many days, a countdown sits in the top bar on every screen.
pub const WARNING_DAYS: i64 = 7;
/// From this many days, a red banner sits on every screen.
pub const URGENT_DAYS: i64 = 3;
/// An emergency window is always a warning; in its last days, urgent.
pub const EMERGENCY_URGENT_DAYS: i64 = 2;
/// How far the system clock may sit behind the latest recorded time before it counts
/// as rolled back. Generous enough for a time-zone or daylight-saving mistake.
pub const CLOCK_TOLERANCE_SECS: i64 = 2 * 3600;
/// How long an offline queue may hold a sale and still have it judged by when it
/// happened (see `recording_allowed_at`).
pub const OCCURRENCE_WINDOW_DAYS: i64 = 30;

const DAY: i64 = 86_400;
/// How far before an emergency window's end a queued sale still counts as covered.
const UNLOCK_COVER_DAYS: i64 = crate::unlock::MAX_DAYS as i64 + 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No licence. The state of a new installation.
    Unlicensed,
    Trial,
    /// An emergency unlock code is keeping the shop fully working.
    Emergency,
    /// A trial or an emergency window has ended and the grace days are running.
    /// Fully working.
    Grace,
    /// A trial and its grace are over.
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
            Status::Emergency => "EMERGENCY",
            Status::Grace => "GRACE",
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

/// What a working status rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    Trial,
    Perpetual,
    Emergency,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Trial => "trial",
            Basis::Perpetual => "perpetual",
            Basis::Emergency => "emergency",
        }
    }
}

/// How loudly the screens say it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Warning {
    None,
    /// In the bell.
    Notice,
    /// A countdown in the top bar of every screen.
    Warning,
    /// A red banner on every screen.
    Urgent,
}

impl Warning {
    pub fn as_str(self) -> &'static str {
        match self {
            Warning::None => "none",
            Warning::Notice => "notice",
            Warning::Warning => "warning",
            Warning::Urgent => "urgent",
        }
    }

    fn for_trial(days_left: i64) -> Warning {
        if days_left <= URGENT_DAYS {
            Warning::Urgent
        } else if days_left <= WARNING_DAYS {
            Warning::Warning
        } else if days_left <= NOTICE_DAYS {
            Warning::Notice
        } else {
            Warning::None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub status: Status,
    pub basis: Option<Basis>,
    pub expires_at: Option<i64>,
    pub grace_ends_at: Option<i64>,
    /// Whole days left — until expiry in TRIAL and EMERGENCY, until the grace ends in
    /// GRACE.
    pub days_left: Option<i64>,
    pub warning: Warning,
    /// Seconds the clock sits behind the latest recorded time, when TAMPERED by clock.
    pub clock_behind_by: Option<i64>,
}

impl Evaluation {
    fn plain(status: Status, basis: Option<Basis>) -> Self {
        Evaluation {
            status,
            basis,
            expires_at: None,
            grace_ends_at: None,
            days_left: None,
            warning: if status.read_only() { Warning::Urgent } else { Warning::None },
            clock_behind_by: None,
        }
    }

    /// TAMPERED because every stored code failed its signature: the database was edited.
    pub fn stored_code_invalid() -> Self {
        Evaluation::plain(Status::Tampered, None)
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

/// The status of one licence at `now`, given the latest time ever recorded here.
///
/// For a trial, the licence's own issue time is one more anchor: a machine whose clock
/// reads earlier than the moment the vendor issued its code has been set back.
pub fn evaluate(license: Option<&Payload>, now: i64, latest_seen: Option<i64>) -> Evaluation {
    let Some(license) = license else {
        return Evaluation::plain(Status::Unlicensed, None);
    };

    if license.kind == LicenseKind::Perpetual {
        return Evaluation::plain(Status::Perpetual, Some(Basis::Perpetual));
    }

    let expires_at = license.exp.unwrap_or(license.iat);
    let grace_ends_at = expires_at + GRACE_DAYS * DAY;
    let reference = latest_seen.max(Some(license.iat));
    let timed = |status, days_left, warning| Evaluation {
        status,
        basis: Some(Basis::Trial),
        expires_at: Some(expires_at),
        grace_ends_at: Some(grace_ends_at),
        days_left,
        warning,
        clock_behind_by: None,
    };

    if clock_rolled_back(now, reference) {
        return Evaluation { clock_behind_by: reference.map(|r| r - now), ..timed(Status::Tampered, None, Warning::Urgent) };
    }
    if now < expires_at {
        let days_left = ceil_days(expires_at - now);
        return timed(Status::Trial, Some(days_left), Warning::for_trial(days_left));
    }
    if now < grace_ends_at {
        return timed(Status::Grace, Some(ceil_days(grace_ends_at - now)), Warning::Urgent);
    }
    timed(Status::Expired, Some(0), Warning::Urgent)
}

/// The status of the installation: the governing licence, then any emergency unlocks
/// over it.
///
/// `unlock_ends` are the `valid_until` of every emergency code entered here and
/// re-verified by the caller. An unlock only ever raises the status: it takes over
/// when the licence alone would stop the shop — no licence, an expired one, a clock
/// problem, a stored code that fails its check — and never hides a better licence.
///
/// Its window is judged against the later of the system clock and the latest recorded
/// time, so a clock wound back cannot stretch it. When it ends, the grace days follow,
/// as they do after a trial.
pub fn evaluate_all(
    license: Option<&Payload>,
    stored_code_invalid: bool,
    unlock_ends: &[i64],
    now: i64,
    latest_seen: Option<i64>,
) -> Evaluation {
    let underlying = if license.is_none() && stored_code_invalid {
        Evaluation::stored_code_invalid()
    } else {
        evaluate(license, now, latest_seen)
    };
    if !underlying.status.read_only() && underlying.status != Status::Grace {
        return underlying;
    }

    let Some(&until) = unlock_ends.iter().max() else {
        return underlying;
    };
    let reference = latest_seen.map_or(now, |latest| latest.max(now));
    let grace_ends_at = until + GRACE_DAYS * DAY;

    if reference < until {
        let days_left = ceil_days(until - reference);
        return Evaluation {
            status: Status::Emergency,
            basis: Some(Basis::Emergency),
            expires_at: Some(until),
            grace_ends_at: Some(grace_ends_at),
            days_left: Some(days_left),
            warning: if days_left <= EMERGENCY_URGENT_DAYS { Warning::Urgent } else { Warning::Warning },
            clock_behind_by: underlying.clock_behind_by,
        };
    }
    if reference < grace_ends_at {
        // Two graces running at once — after a trial and after an emergency window —
        // the one that lasts longer is the one the shop has.
        if underlying.status == Status::Grace && underlying.grace_ends_at >= Some(grace_ends_at) {
            return underlying;
        }
        return Evaluation {
            status: Status::Grace,
            basis: Some(Basis::Emergency),
            expires_at: Some(until),
            grace_ends_at: Some(grace_ends_at),
            days_left: Some(ceil_days(grace_ends_at - reference)),
            warning: Warning::Urgent,
            clock_behind_by: underlying.clock_behind_by,
        };
    }
    underlying
}

/// Whether recording was allowed at time `t` — for a sale the till queued while it
/// could not reach the manager PC, and which arrives after the licence lapsed.
///
/// A sale made while the shop was licensed was made while the shop was licensed,
/// whenever it syncs. Clock checks do not apply: this asks about the past, not now.
pub fn recording_allowed_at(licenses: &[Payload], unlock_ends: &[i64], t: i64) -> bool {
    let by_licence = licenses.iter().any(|license| match license.kind {
        LicenseKind::Perpetual => true,
        LicenseKind::Trial => {
            let end = license.exp.unwrap_or(license.iat) + GRACE_DAYS * DAY;
            t >= license.iat - DAY && t < end
        }
    });
    let by_unlock = unlock_ends
        .iter()
        .any(|&until| t >= until - UNLOCK_COVER_DAYS * DAY && t < until + GRACE_DAYS * DAY);
    by_licence || by_unlock
}
