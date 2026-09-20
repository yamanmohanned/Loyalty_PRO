//! What the backend is doing, in words the dashboard can render.
//!
//! ── The defect this closes ───────────────────────────────────────────────────
//!
//! The API produced a correct, specific, actionable Arabic sentence when it refused to
//! start — naming the pending migrations, the free space it found, the space it wanted
//! and what to do about it. That sentence went to `api.log`, in a directory locked to
//! SYSTEM, and was then lifted into `status.json` beside it. Meanwhile the dashboard,
//! which cannot ask a dead API anything, rendered «تعذّر تحميل البيانات. تحقّق من
//! الاتصال بالخادم وأعد المحاولة.» — a sentence that is true of a pulled network cable
//! and of nothing that was actually happening.
//!
//! The message existed. The screen could not reach it. It took four rounds of
//! diagnosis to recover a string that had been written correctly the whole time, and
//! on a merchant's machine there would have been no rounds of diagnosis at all.
//!
//! This is the channel that does not depend on the failed component: the reason is
//! read from disk by the shell process, which is alive precisely because the API is
//! not.
//!
//! ── Starting is not failing ──────────────────────────────────────────────────
//!
//! `state` distinguishes them, because a merchant who is told "failed" during the
//! four seconds a cold SQLite open takes will restart the app, and a merchant told
//! "starting" forever will wait through a fault that needed him. `starting` and
//! `running` come from the supervisor; `terminal` means it has stopped retrying and
//! nothing will change without intervention.

use std::path::{Path, PathBuf};
use serde::Serialize;

/// Written by the service host's `write_status`.
///
/// ── In `logs/`, and that is a correction ─────────────────────────────────────
///
/// This read `<data dir>/status.json` while the service host has always written
/// `<data dir>/logs/status.json`. Two constants, one file, and nothing in either
/// process that could notice the disagreement — so on an installed machine the
/// supervisor's account of itself was never found at all.
///
/// The consequence was not a missing detail. `state` stayed `unknown` forever, which
/// is the branch that renders «لا يمكن الوصول إلى البرنامج» — "the program cannot be
/// reached" — and it was shown during an ordinary cold start, where the correct and
/// already-written answer was «جارٍ تشغيل البرنامج». A merchant was told his software
/// was unreachable for the several seconds it takes SQLite to open, every launch.
///
/// The log directory is also the only one the logged-on user can read: `%PROGRAMDATA%\Walaa`
/// itself is locked to SYSTEM and Administrators because the database in it holds every
/// customer's phone number. So the wrong path was unreadable as well as absent.
const STATUS_FILE: &str = "logs/status.json";
/// Written by the API's own `recordStartupFailure`, inside the logs directory.
const STARTUP_ERROR: &str = "logs/startup-error.json";

#[derive(Serialize, Default)]
pub struct BackendStatus {
    /// `starting` | `running` | `failed` | `terminal` | `stopped` | `unknown`
    pub state: String,
    /// The API's own Arabic explanation, verbatim, when there is one.
    pub reason: Option<String>,
    /// How many times the same failure has repeated.
    pub attempts: u32,
    /// When the supervisor last wrote.
    pub at: Option<String>,
    /// The files consulted, so a support call never has to guess which install is live.
    /// Named even when nothing was found — "I looked here and there was nothing" is a
    /// different fact from "I did not look", and the whole class of defect this module
    /// exists for came from nobody being able to tell those apart.
    pub checked: Vec<String>,
    /// The port the backend is actually listening on.
    ///
    /// A demo build knows it in this process, because this process chose it. A
    /// production install does not: the port is fixed at install time inside
    /// `loyalty-pro.env`, which is locked to SYSTEM and Administrators. The service — which
    /// can read it — publishes it into `status.json` instead, which is how the
    /// dashboard resolves its own backend with nothing configured.
    pub port: Option<u16>,
    /// True for a demo build, so the UI can name the right remedy.
    pub demo: bool,

    /* ── Does this machine HOST a backend? ───────────────────────────────────
       ─────────────────────────────────────────────────────────────────────────

       Three facts that were missing, and whose absence produced the worst message in
       the product. On a manager PC whose `loyalty-pro.env` had gone, `backend_port`
       returned `None`, the dashboard read that as "no address resolved", and showed
       «لم يُعثر على خادم ولاء» **with a box asking the shop owner to type a server
       address** — on the machine that IS the server.

       Three things wrong with that at once. The cause was wrong: the settings file
       was missing, not the server. The remedy was wrong: no address he could type
       would have helped, because the service on this machine still would not start.
       And the field must not exist here at all — a control offering to repoint a
       working manager PC at another machine is how a merchant talks himself into
       breaking a working install.

       So the shell reports what it can see of the installation rather than leaving
       the frontend to infer it from a missing port. */

    /// Whether this installation includes the service — `loyalty-pro-service.exe` beside the
    /// app. False on a second machine that only runs the dashboard, which is the ONE
    /// place an address field belongs.
    pub hosts_service: bool,
    /// Whether `loyalty-pro.env` is present. Its absence is a distinct failure with a
    /// distinct remedy, and it is the one that was being reported as "no server".
    pub config_present: bool,
    /// Whether a database file exists in the data directory. Decides whether a missing
    /// configuration is an empty machine or a shop whose settings have been lost.
    pub database_present: bool,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    // Both writers prefix a BOM so PowerShell 5.1 and Notepad render the Arabic
    // correctly; `serde_json` will not parse one.
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// The database file this build opens, by name.
const PRODUCTION_DATABASE: &str = "loyalty-pro.db";
const DEMO_DATABASE: &str = "loyalty-pro-demo.db";

/// Reads the backend's own account of itself, and what this machine has installed.
///
/// `service_dir` is where the shipped runtime lives. `None` when the caller could not
/// work it out, which is reported as "this machine hosts no service" — the honest
/// answer, and the one that errs towards offering an address field rather than
/// withholding it on a machine that genuinely needs one.
pub fn read(
    data_dir: &PathBuf,
    demo: bool,
    port: Option<u16>,
    service_exe: Option<&Path>,
) -> BackendStatus {
    let status_path = data_dir.join(STATUS_FILE);
    let error_path = data_dir.join(STARTUP_ERROR);

    let mut out = BackendStatus {
        state: "unknown".into(),
        checked: vec![
            status_path.display().to_string(),
            error_path.display().to_string(),
        ],
        port,
        demo,
        hosts_service: service_exe.map(|p| p.exists()).unwrap_or(false),
        config_present: data_dir.join("loyalty-pro.env").exists(),
        database_present: data_dir
            .join(if demo { DEMO_DATABASE } else { PRODUCTION_DATABASE })
            .exists(),
        ..Default::default()
    };

    if let Some(v) = read_json(&status_path) {
        if let Some(s) = v.get("state").and_then(|s| s.as_str()) {
            out.state = s.to_string();
        }
        out.attempts = v.get("attempts").and_then(|a| a.as_u64()).unwrap_or(0) as u32;
        out.at = v.get("at").and_then(|a| a.as_str()).map(str::to_string);
        out.reason = v
            .get("reason")
            .and_then(|r| r.as_str())
            .filter(|r| !r.is_empty())
            .map(str::to_string);

        // The in-process port wins when there is one: a demo build chose it here and
        // the file is only its echo. Otherwise this is the sole source, and it is
        // `null` rather than a guess whenever the service could not read its own
        // configuration — so `None` here means "unknown", never "probably 4100".
        if out.port.is_none() {
            out.port = v
                .get("port")
                .and_then(|p| p.as_u64())
                .and_then(|p| u16::try_from(p).ok());
        }
    }

    // The API's own file is the better source when both exist: the supervisor copies
    // the reason across, but the API writes it first and writes it in full.
    if let Some(v) = read_json(&error_path) {
        if let Some(reason) = v.get("reason").and_then(|r| r.as_str()) {
            if !reason.is_empty() {
                out.reason = Some(reason.to_string());
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch data directory holding whatever `logs/status.json` we want to test.
    fn data_dir_with(status: &str, name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("walaa-status-test-{name}"));
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join(STATUS_FILE.rsplit('/').next().unwrap()), status).unwrap();
        dir
    }

    /// The regression this whole change exists for: the file is in `logs/`, and the
    /// reader used to look one directory up and find nothing on every installed machine.
    #[test]
    fn reads_the_status_file_from_the_logs_directory() {
        let dir = data_dir_with(
            r#"{"state":"running","at":"2026-09-08 02:00:00Z","attempts":0,"port":4791,"reason":null}"#,
            "logs-dir",
        );
        let out = read(&dir, false, None, None);
        assert_eq!(out.state, "running");
        assert_eq!(out.port, Some(4791));
    }

    /// Zero configuration: a production build learns its port from this file alone.
    #[test]
    fn takes_the_port_from_the_file_when_the_process_has_none() {
        let dir = data_dir_with(
            r#"{"state":"running","at":"x","attempts":0,"port":5123,"reason":null}"#,
            "port-from-file",
        );
        assert_eq!(read(&dir, false, None, None).port, Some(5123));
    }

    /// A demo chose its own port in this process; the file is only an echo of it.
    #[test]
    fn the_in_process_port_wins_over_the_file() {
        let dir = data_dir_with(
            r#"{"state":"running","at":"x","attempts":0,"port":5123,"reason":null}"#,
            "in-process-wins",
        );
        assert_eq!(read(&dir, true, Some(6001), None).port, Some(6001));
    }

    /// `null` means the service could not read its own configuration. It must stay
    /// unknown rather than becoming a guess — a wrong port produces a confident
    /// "the server is not responding" screen, which is worse than an honest one.
    #[test]
    fn an_unknown_port_stays_unknown() {
        let dir = data_dir_with(
            r#"{"state":"failed","at":"x","attempts":2,"port":null,"reason":"سبب"}"#,
            "unknown-port",
        );
        let out = read(&dir, false, None, None);
        assert_eq!(out.port, None);
        assert_eq!(out.reason.as_deref(), Some("سبب"));
    }

    /// No file at all: the state is `unknown`, and both paths consulted are named.
    #[test]
    fn a_missing_file_is_unknown_and_names_what_it_looked_at() {
        let dir = std::env::temp_dir().join("walaa-status-test-absent");
        let _ = fs::remove_dir_all(&dir);
        let out = read(&dir, false, None, None);
        assert_eq!(out.state, "unknown");
        assert_eq!(out.port, None);
        assert_eq!(out.checked.len(), 2);
    }

    /// The fact whose absence produced «لم يُعثر على خادم ولاء» plus an address box on
    /// the machine that IS the server.
    #[test]
    fn reports_whether_this_machine_hosts_the_service() {
        let dir = data_dir_with(
            r#"{"state":"failed","at":"x","attempts":1,"port":null,"reason":"سبب"}"#,
            "hosts-service",
        );
        let exe = dir.join("loyalty-pro-service.exe");

        // Not installed here: the dashboard may legitimately ask for an address.
        assert!(!read(&dir, false, None, Some(&exe)).hosts_service);

        fs::write(&exe, b"not really a binary, but it exists").unwrap();
        assert!(read(&dir, false, None, Some(&exe)).hosts_service);
    }

    /// A missing `loyalty-pro.env` is its own state, and the one that was being reported as
    /// "no server found".
    #[test]
    fn reports_whether_the_configuration_file_is_there() {
        let dir = data_dir_with(
            r#"{"state":"failed","at":"x","attempts":1,"port":null,"reason":"سبب"}"#,
            "config-present",
        );
        assert!(!read(&dir, false, None, None).config_present);

        fs::write(dir.join("loyalty-pro.env"), b"API_PORT=4100
").unwrap();
        assert!(read(&dir, false, None, None).config_present);
    }

    /// Whether a shop's database is sitting there decides whether a lost configuration
    /// is an empty machine or a shop whose signing keys must not be regenerated.
    #[test]
    fn reports_whether_a_database_is_present_for_this_build() {
        let dir = data_dir_with(
            r#"{"state":"stopped","at":"x","attempts":0,"port":4100,"reason":null}"#,
            "database-present",
        );
        assert!(!read(&dir, false, None, None).database_present);

        // A production build looks for `loyalty-pro.db` and a demo for `loyalty-pro-demo.db`: the
        // two never share a file, so neither may answer for the other.
        fs::write(dir.join("loyalty-pro.db"), b"x").unwrap();
        assert!(read(&dir, false, None, None).database_present);
        assert!(!read(&dir, true, None, None).database_present);
    }
}
