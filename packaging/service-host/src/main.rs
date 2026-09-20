//! Windows Service host for the Walaa API (ولاء).
//!
//! docs/legacy/CLAUDE_v3.md §12.3 requires the API to run as a Windows Service rather than a
//! Tauri sidecar: the Loyalty Station and the Print Capture Agent need it alive for
//! every trading hour, whether or not the manager has the dashboard window open.
//!
//! Windows will not start an arbitrary executable as a service. A service must
//! connect to the Service Control Manager, report its state, and answer control
//! requests — none of which a Node process can do. This binary is that shim, and it
//! also supervises: it restarts the API if it dies, writes its output somewhere a
//! support call can read, and stops it cleanly on shutdown.
//!
//! ## Stopping a child that has no console
//!
//! Windows has no SIGTERM. The usual answer, `GenerateConsoleCtrlEvent`, needs a
//! console — and a service has none, so it cannot send CTRL_BREAK to its child at
//! all. The remaining choices were a control port on localhost (a new authenticated
//! surface on a machine whose whole security model is "no inbound network") or
//! closing a pipe the child already holds. This host keeps the child's stdin open and
//! closes it to ask for shutdown; `apps/api/src/server.ts` treats that as the stop
//! signal when `LOYALTY_SUPERVISED=1`. If the child has not exited within
//! `STOP_GRACE`, it is terminated — SQLite is in WAL mode, so even that is safe,
//! it just costs the in-flight request.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::RngCore;
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

/// The Service Control Manager key. **Do not rename** (§12.35).
///
/// It is how an upgrade finds the service it is replacing. Rename it and the
/// installer registers a second service while the first keeps running from the old
/// binaries — holding the API port and `loyalty-pro.db` open, so the new one cannot bind.
/// The product was renamed to "Customer loyalty" on 2026-09-02 and this stayed.
const SERVICE_NAME: &str = "LoyaltyProApi";
/// What services.msc shows. Safe to change: the SCM keys on `SERVICE_NAME`.
const DISPLAY_NAME: &str = "Loyalty Pro API";
/// Name of the inbound firewall rule that lets the Loyalty Station reach the API.
///
/// **Do not rename** without deleting the old rule by its old name first: the rule
/// is created and removed by name, so a rename orphans the previous one — left open
/// on the shop's network with nothing to close it — and adds a duplicate beside it.
const FIREWALL_RULE: &str = "Loyalty Pro API";

const DESCRIPTION: &str =
    "خدمة Customer loyalty — واجهة البرمجة وقاعدة البيانات المحلية. Local API and SQLite datastore for the Customer loyalty system.";

/// How long a stopping child gets to finish in-flight work before it is terminated.
/// The database filename each build kind opens. They differ on purpose — see
/// `Paths::database`. Changing either without changing `apps/api/src/lib/demo-guard.ts`
/// breaks the runtime guard that checks them.
const PRODUCTION_DATABASE_NAME: &str = "loyalty-pro.db";
const DEMO_DATABASE_NAME: &str = "loyalty-pro-demo.db";

/// What `install_demo_seed_if_absent` did, so the caller can say so in the log.
enum SeedPlacement {
    /// The seed was copied into the data directory.
    Placed(PathBuf),
    /// A database was already there and was left alone.
    KeptExisting(PathBuf),
    /// No seed ships with this build.
    NotADemoBuild,
}

const STOP_GRACE: Duration = Duration::from_secs(15);
/// A child that stayed up this long is considered healthy; the restart backoff resets.
/// How long a child must survive before a PREVIOUS failure is considered forgiven.
///
/// A minute, because the failures worth forgetting are the ones that killed the child
/// within seconds; something that ran for a minute and then died is a new event, not a
/// repeat of the old one.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

/// How long a child must survive before it is REPORTED as running.
///
/// Deliberately not the same number. These answer different questions — "is it up?" and
/// "has it been up long enough that the last failure no longer counts?" — and sharing
/// one constant meant `status.json` said "starting" for a full minute after a start
/// that had already succeeded. Anything reading that file in the meantime, including
/// the dashboard's own failure screen, saw a product that had not come up yet.
///
/// Five seconds is the settle: long enough that a child which dies immediately is not
/// announced as running, short enough that nobody watches a stale word.
const RUNNING_AFTER: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// The API's "restart me" exit code — `apps/api/src/lib/lifecycle.ts` carries the same
/// number. A restore the owner confirmed is applied at the API's next start, before it
/// opens the database, so applying one means ending the process on purpose. That is not
/// a fault: the API is started again at once, with no backoff, and it does not count
/// towards giving up.
const RESTART_EXIT_CODE: i32 = 75;
/// Rotate the API log at this size. A shop runs for years; an unbounded log is a
/// disk-full outage waiting for a quiet Tuesday.
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;
/// How often the supervisor re-checks the API log's size while the API is running.
///
/// The cap used to be enforced only at spawn, which meant it was not a cap at all: a
/// service that starts at boot and runs for months never re-checks, and the log grows
/// without limit on the same volume as the database (§12.15). One `stat` a minute is
/// nothing next to that.
const LOG_CHECK_INTERVAL: Duration = Duration::from_secs(60);

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static DATA_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

// ─────────────────────────────────────────────────────────────────────────────────
//  Paths
// ─────────────────────────────────────────────────────────────────────────────────

struct Paths {
    /// Where the staged runtime lives — read-only to the service account.
    program: PathBuf,
    /// Everything writable: database, configuration, logs.
    data: PathBuf,
    env_file: PathBuf,
    migrations: PathBuf,
    logs: PathBuf,
}

impl Paths {
    fn resolve() -> Result<Paths, String> {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        let program = exe
            .parent()
            .ok_or_else(|| "executable has no parent directory".to_string())?
            .to_path_buf();

        let data = DATA_DIR_OVERRIDE
            .get()
            .cloned()
            .or_else(|| std::env::var_os("LOYALTY_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(|| {
                let program_data = std::env::var_os("PROGRAMDATA")
                    .unwrap_or_else(|| OsString::from("C:\\ProgramData"));
                Path::new(&program_data).join("LoyaltyPro")
            });

        Ok(Paths {
            env_file: data.join("loyalty-pro.env"),
            logs: data.join("logs"),
            migrations: program.join("migrations"),
            program,
            data,
        })
    }

    fn ensure_directories(&self) -> Result<(), String> {
        fs::create_dir_all(&self.data).map_err(|e| format!("create {}: {e}", self.data.display()))?;
        fs::create_dir_all(&self.logs).map_err(|e| format!("create {}: {e}", self.logs.display()))?;
        Ok(())
    }

    /// The pre-seeded demo database, if this is a demo build.
    fn demo_seed(&self) -> PathBuf {
        self.program.join(DEMO_DATABASE_NAME)
    }

    /// Whether this installation is a demo build.
    ///
    /// The shipped seed's presence IS the signal, here and in `spawn_api`. There is no
    /// separate flag file that could fall out of step with the thing it describes.
    fn is_demo(&self) -> bool {
        self.demo_seed().exists()
    }

    /// The live database the API opens.
    ///
    /// ── Why the two builds use different names ───────────────────────────────
    ///
    /// They used to share one. The demo shipped its shop as `loyalty-pro-demo.db` and then
    /// configured the API to open `loyalty-pro.db`, and `install_demo_seed_if_absent` — which
    /// declines to overwrite an existing database, correctly — found a `loyalty-pro.db` left
    /// by an earlier install and silently handed it over. The demo spent its whole life
    /// attached to a database nobody had placed. On the machine where this was caught
    /// the file was empty; on a merchant's machine it would have been his customers.
    ///
    /// Giving each build its own name makes that adoption impossible rather than
    /// unlikely: a demo build has no code path that opens `loyalty-pro.db`, and a production
    /// build has none that opens `loyalty-pro-demo.db`. It also repairs a second bug for
    /// free — `assertDemoDatabase()` in the API gates the destructive reset on the open
    /// file's name containing `demo`, which under the old scheme was never true in a
    /// shipped demo, so the reset control was rendered and could not work.
    fn database(&self) -> PathBuf {
        self.data.join(if self.is_demo() {
            DEMO_DATABASE_NAME
        } else {
            PRODUCTION_DATABASE_NAME
        })
    }

    /// Places the demo shop on a machine that has never run this before.
    ///
    /// **A file copy, not a seed run.** Building the demo shop replays six months of
    /// trading through the real services and takes about half a minute; doing that on
    /// first launch would mean the merchant double-clicks the installer's shortcut and
    /// watches a blank window while it happens. The build already paid that cost, so
    /// the installer ships the finished `.db` and this copies it into place.
    ///
    /// Only ever writes when there is no database at all, so a merchant who has been
    /// clicking around for a week does not lose it to a service restart. Rebuilding on
    /// demand is a separate, explicit action — the reset control in the app.
    fn install_demo_seed_if_absent(&self) -> Result<SeedPlacement, String> {
        let seed = self.demo_seed();
        let live = self.database();
        if !seed.exists() {
            return Ok(SeedPlacement::NotADemoBuild);
        }
        if live.exists() {
            return Ok(SeedPlacement::KeptExisting(live));
        }
        fs::copy(&seed, &live)
            .map_err(|e| format!("copy demo seed {} -> {}: {e}", seed.display(), live.display()))?;
        Ok(SeedPlacement::Placed(live))
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────────────────────────

/// How many times an IDENTICAL failure is retried before the supervisor gives up.
///
/// Not a generic retry cap — a cap on repeating the *same* failure. A child that dies
/// with a new reason each time is a machine in trouble and worth retrying; a child that
/// dies with the identical exit code and the identical sentence five times running is a
/// configuration or environment fault, and the sixth attempt will fail too.
///
/// **The number exists because the alternative did real damage.** With unbounded retry,
/// a disk-space refusal became a service that reported `Running` to the SCM and
/// relaunched a doomed child every thirty seconds, indefinitely, while every surface a
/// person looks at — the service state, the port, the dashboard — showed nothing that
/// pointed at the cause. A shop machine can sit like that all morning.
const IDENTICAL_FAILURES_BEFORE_GIVING_UP: u32 = 5;

/// Escapes a sentence for embedding in a JSON string literal.
fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for c in input.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => out.push(' '),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Writes `status.json` beside the logs.
///
/// ── Why a file, and why in the log directory ─────────────────────────────────
///
/// The desktop app cannot ask the API why the API is down. Anything served by the API
/// is unavailable in exactly the situation where the answer is needed, so the answer
/// has to live somewhere outside its lifetime. A file in the log directory is the
/// smallest thing that works: no port, no protocol, no second listener to secure — and
/// the log directory is already the one place the interactive user can read
/// (`relax_log_directory`).
///
/// The app polls this when its health check fails, and renders `reason` verbatim.
/// `state` is one of `starting`, `running`, `failed`, `terminal`, `stopped`.
///
/// ── `port` is here so the dashboard needs no configuration ───────────────────
///
/// The manager machine runs its own backend, so asking its owner to type an address
/// is asking him a question the machine can already answer. The one thing the shell
/// could not previously discover was the PORT: it is fixed at install time and lives
/// in `loyalty-pro.env`, which `restrict_permissions` locks to SYSTEM and Administrators —
/// deliberately, because that file holds the JWT signing keys. The interactive user
/// cannot read it, and must not be able to.
///
/// So the service, which runs as SYSTEM and can read it, publishes the port alone into
/// the one file the logged-on user is already allowed to read. A port number is not a
/// secret: the firewall rule beside it announces the same number to the whole LAN, and
/// it is the entirety of what the dashboard needs in order to find its own backend.
fn write_status(paths: &Paths, state: &str, attempts: u32, reason: Option<&str>) {
    let _ = fs::create_dir_all(&paths.logs);

    // Hand-rolled JSON: four fields, and no serde in a binary whose whole job is to be
    // small and boring.
    let reason_field = match reason {
        Some(r) => format!("\"{}\"", json_escape(r)),
        None => "null".to_string(),
    };

    // The port, or `null`. Never a guess — see `configured_port_opt`.
    let port_field = match SERVING_PORT.get() {
        Some(port) => port.to_string(),
        None => "null".to_string(),
    };

    let body = format!(
        "{{\n  \"state\": \"{}\",\n  \"at\": \"{}\",\n  \"attempts\": {},\n  \"port\": {},\n  \"reason\": {}\n}}\n",
        state,
        utc_now(),
        attempts,
        port_field,
        reason_field
    );

    if let Ok(mut file) = File::create(paths.logs.join("status.json")) {
        let _ = file.write_all(UTF8_BOM);
        let _ = file.write_all(body.as_bytes());
    }
}

/// Reads the reason the API recorded for its own refusal to start.
///
/// The API writes `startup-error.json` before exiting (`recordStartupFailure` in
/// `server.ts`), because it is the only party that knows *why*. The supervisor knows
/// only that a child exited 1. Lifting that sentence into `status.json` is what puts a
/// real explanation in front of the merchant instead of an exit code.
///
/// A hand-rolled field read rather than a JSON parser: the file is written by us, in a
/// known shape, and the alternative is a dependency in a binary that deliberately has
/// almost none.
fn read_child_startup_error(paths: &Paths) -> Option<String> {
    let raw = fs::read_to_string(paths.logs.join("startup-error.json")).ok()?;
    let trimmed = raw.trim_start_matches('\u{feff}');

    let key = "\"reason\"";
    let start = trimmed.find(key)? + key.len();
    let after_colon = trimmed[start..].find('"')? + start + 1;

    let mut out = String::new();
    let mut chars = trimmed[after_colon..].chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('n') | Some('r') | Some('t') => out.push(' '),
                Some(other) => out.push(other),
                None => break,
            },
            '"' => break,
            other => out.push(other),
        }
    }

    if out.trim().is_empty() {
        None
    } else {
        Some(out.trim().to_string())
    }
}

/// Clears a stale failure record so a later success cannot show yesterday's reason.
fn clear_child_startup_error(paths: &Paths) {
    let _ = fs::remove_file(paths.logs.join("startup-error.json"));
}

/// The UTF-8 byte-order mark.
///
/// Written at the head of every log file this product creates, and it is not
/// decoration. Windows PowerShell 5.1's `Get-Content` and Notepad both fall back to
/// the system ANSI code page for a UTF-8 file with no BOM — so the API's Arabic
/// diagnostics came back as `ØªØ¹Ø°Ù‘Ø±` when the operator finally read them, which
/// is a log that technically exists and practically does not. Every message this
/// system writes for a human to read is in Arabic; the BOM is what makes them
/// readable with the tools a person actually has to hand.
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Opens a log file for appending, writing the BOM if the file is new or empty.
fn open_log(path: &Path) -> Option<File> {
    let mut file = OpenOptions::new().create(true).append(true).open(path).ok()?;
    // `len() == 0` covers both a fresh file and one just rotated away — the rotation
    // renames the old file aside, so the next open lands on an empty one.
    if file.metadata().map(|m| m.len()).unwrap_or(1) == 0 {
        let _ = file.write_all(UTF8_BOM);
    }
    Some(file)
}

/// Appends one timestamped line to the host's own log.
///
/// Deliberately not a logging crate: this writes a handful of lines per day and the
/// file is read by a human on a support call, so a dependency-free appender that can
/// never itself fail loudly is the right size of tool.
fn log_line(logs: &Path, message: &str) {
    let _ = fs::create_dir_all(logs);
    if let Some(mut file) = open_log(&logs.join("service.log")) {
        let _ = writeln!(file, "{} {}", utc_now(), message);
    }
}

/// `YYYY-MM-DD HH:MM:SSZ` from the system clock, without pulling in a date crate.
fn utc_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    let days = seconds.div_euclid(86_400);
    let time_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch to a calendar date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Renames the API log aside once it passes the size cap, keeping one generation.
///
/// Only correct before the child is spawned, when nothing holds the file open. While the
/// API is running, use [`rotate_running_if_large`].
fn rotate_if_large(path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > LOG_ROTATE_BYTES {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
    }
}

/// Caps the API log while the API is still writing to it.
///
/// Copy-then-truncate rather than rename, and the difference is not stylistic. The child
/// inherited an append handle to this file; a rename moves the *name*, not the handle, so
/// the child would go on appending to `api.log.1` while `api.log` never reappeared —
/// rotation that renames the growing file rather than stopping it growing. Truncating in
/// place is the one operation that reaches the bytes the child is actually writing.
///
/// This depends on the handle being opened in APPEND mode (see `spawn_api`): append
/// writes go to end-of-file, which after truncation is zero. A plain write handle would
/// keep its old offset and leave a multi-megabyte sparse hole instead.
///
/// The cost is a race — lines written between the copy and the truncation are lost. For a
/// log that is the right trade against an unbounded file on the volume that holds the
/// database.
fn rotate_running_if_large(path: &Path, limit: u64) {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > limit => {}
        _ => return,
    }

    if fs::copy(path, path.with_extension("log.1")).is_err() {
        return;
    }

    if let Ok(file) = OpenOptions::new().write(true).open(path) {
        let _ = file.set_len(0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Supervision
// ─────────────────────────────────────────────────────────────────────────────────

fn spawn_api(paths: &Paths) -> Result<Child, String> {
    let node = paths.program.join("node.exe");
    if !node.exists() {
        log_line(&paths.logs, &format!("node runtime missing: {}", node.display()));
        // The sentence reaches the merchant verbatim through `status.json`; the path
        // goes to the log line above. A reinstall genuinely repairs this one: it
        // replaces the program and never touches the data.
        return Err(concat!(
            "تعذّر تشغيل الخدمة: ملفات البرنامج المثبّتة ناقصة — محرّك التشغيل غير موجود. ",
            "هذه مشكلة في التثبيت وليست في بياناتك. أعد تثبيت البرنامج من ملف التثبيت الكامل؛ ",
            "التثبيت يستبدل ملفات البرنامج ولا يمسّ بيانات المتجر."
        )
        .to_string());
    }

    // Before the API opens the file: a demo build carries its shop with it, and the
    // copy has to land before Prisma creates an empty database in its place.
    match paths.install_demo_seed_if_absent() {
        Ok(SeedPlacement::Placed(live)) => log_line(
            &paths.logs,
            &format!(
                "demo database installed from shipped seed: {} -> {}",
                paths.demo_seed().display(),
                live.display()
            ),
        ),
        // Named rather than silent. The whole demo-adopts-a-stranger's-database defect
        // was one unlogged early return, so whichever branch runs, the log says which
        // file the API is about to open and why.
        Ok(SeedPlacement::KeptExisting(live)) => log_line(
            &paths.logs,
            &format!(
                "demo database already present, keeping it: {} (seed {} not copied)",
                live.display(),
                paths.demo_seed().display()
            ),
        ),
        Ok(SeedPlacement::NotADemoBuild) => {}
        Err(error) => log_line(&paths.logs, &format!("demo seed copy failed: {error}")),
    }

    /*
      A database belonging to the OTHER build kind, sitting in this build's data
      directory.

      It is never opened — `Paths::database()` cannot name it — so this is not a
      correctness problem. It is logged because "silently inherited" is the exact
      failure this whole area is being repaired for, and an unexplained 5 MB file in
      the data directory is something a support call should be able to see accounted
      for rather than discover and wonder about. Left in place, not deleted: it is not
      this build's file, and deleting a database nobody asked us to delete is a worse
      mistake than leaving one.
    */
    let stray = paths.data.join(if paths.is_demo() {
        PRODUCTION_DATABASE_NAME
    } else {
        DEMO_DATABASE_NAME
    });
    if stray.exists() {
        log_line(
            &paths.logs,
            &format!(
                "ignoring {} — it belongs to the other build kind and is never opened",
                stray.display()
            ),
        );
    }

    let api_log = paths.logs.join("api.log");
    rotate_if_large(&api_log);
    // Through `open_log`, so node's Arabic stack traces are readable in PowerShell and
    // Notepad rather than mojibake.
    let out = open_log(&api_log)
        .ok_or_else(|| {
            concat!(
                "تعذّر تشغيل الخدمة: لا يمكن فتح ملف سجلّ البرنامج. ",
                "أعد تشغيل الجهاز، وإن تكرّر فتواصل مع الدعم الفني."
            )
            .to_string()
        })?;
    let err = out.try_clone().map_err(|_| {
            concat!(
                "تعذّر تشغيل الخدمة: لا يمكن فتح ملف سجلّ البرنامج. ",
                "أعد تشغيل الجهاز، وإن تكرّر فتواصل مع الدعم الفني."
            )
            .to_string()
        })?;

    Command::new(node)
        .arg("loyalty-pro-api.cjs")
        .current_dir(&paths.program)
        .env("NODE_ENV", "production")
        .env("LOYALTY_DATA_DIR", &paths.data)
        .env("LOYALTY_ENV_FILE", &paths.env_file)
        .env("LOYALTY_MIGRATIONS_DIR", &paths.migrations)
        .env("LOYALTY_SUPERVISED", "1")
        // Demo builds ship the seed database beside the service. Its presence IS the
        // signal — there is no separate flag file to fall out of step with it, and a
        // production install has no such file to find.
        .env(
            "LOYALTY_DEMO",
            if paths.demo_seed().exists() { "1" } else { "0" },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("spawn node: {e}"))
}

/// Closes the child's stdin and waits, then terminates if it outstays its welcome.
fn stop_child(child: &mut Child, paths: &Paths) {
    drop(child.stdin.take());

    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                log_line(&paths.logs, &format!("api exited cleanly ({status})"));
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                log_line(&paths.logs, &format!("try_wait failed: {error}"));
                break;
            }
        }
    }

    log_line(
        &paths.logs,
        "api did not stop within the grace period — terminating",
    );
    let _ = child.kill();
    let _ = child.wait();
}

/// Keeps the API running until `stop` fires. Returns when the stop is complete.
///
/// ── Bounded retry, and a written reason ──────────────────────────────────────
///
/// This used to retry forever and say nothing anybody could read. When the API refused
/// to start — correctly, with a precise Arabic explanation — the result was a service
/// reporting `Running` to the SCM, no listener on the port, a doomed child relaunched
/// every thirty seconds, and a dashboard saying "check the connection to the server".
/// The explanation existed the whole time, in a file locked to SYSTEM.
///
/// Two changes close that:
///
///   1. **The reason is published.** After each death the supervisor lifts the child's
///      own `startup-error.json` into `status.json`, in the one directory the
///      interactive user can read. The desktop app renders it verbatim.
///   2. **Identical failures are bounded.** Five deaths with the same signature and the
///      supervisor stops, records `terminal`, and waits for a stop rather than churning.
///      A *different* failure each time resets the count — that is a machine in trouble,
///      not a fixed fault, and it is worth continuing to retry.
fn supervise(paths: &Paths, stop: Receiver<()>) {
    /*
      The port, resolved once and published with every status write.

      This is what lets the manager dashboard find its own backend without anybody
      typing an address: the service account can read `loyalty-pro.env`, the logged-on user
      cannot, and `status.json` in the log directory is the one file that crosses that
      boundary. `console` has already recorded its `--port` by the time it gets here,
      and `OnceLock` keeps that authoritative value rather than re-reading a file.
    */
    if let Some(port) = configured_port_opt(paths) {
        remember_serving_port(port);
    }

    let mut backoff = Duration::from_secs(2);
    let api_log = paths.logs.join("api.log");
    let mut last_log_check = Instant::now();

    // The signature of the previous failure, and how many times it has repeated.
    let mut last_signature: Option<String> = None;
    let mut identical: u32 = 0;
    // Whether THIS attempt has already been declared running. Reset per attempt below.
    let mut announced_healthy;

    loop {
        let started = Instant::now();
        announced_healthy = false;
        // Set when THIS attempt ended with RESTART_EXIT_CODE.
        let mut restart_requested = false;

        // A fresh attempt must not inherit the previous attempt's explanation.
        clear_child_startup_error(paths);
        write_status(paths, "starting", identical, None);

        let mut child = match spawn_api(paths) {
            Ok(child) => {
                log_line(&paths.logs, &format!("api started (pid {})", child.id()));
                child
            }
            Err(error) => {
                log_line(&paths.logs, &format!("failed to start api: {error}"));
                write_status(paths, "failed", identical + 1, Some(&error));

                // A missing runtime will not fix itself, but a locked log file might;
                // back off and keep trying rather than leaving the shop with a dead
                // service and no explanation.
                match stop.recv_timeout(backoff) {
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };

        // Wait for either a stop request or the child dying.
        // Bound by the loop below, which only leaves via `break` with a value or via
        // `return`. Declared without an initialiser so the compiler proves that.
        let exit_status: String;
        loop {
            match stop.recv_timeout(Duration::from_millis(250)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                    stop_child(&mut child, paths);
                    write_status(paths, "stopped", 0, None);
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }

            if last_log_check.elapsed() >= LOG_CHECK_INTERVAL {
                rotate_running_if_large(&api_log, LOG_ROTATE_BYTES);
                last_log_check = Instant::now();
            }

            /*
              A child that has been up long enough to be healthy says so, once.

              The `identical != 0` condition used to guard this whole block, which meant
              a first start that simply worked never announced itself: `identical` is 0
              on the happy path, so `status.json` sat at "starting" for as long as the
              shop stayed open. Anyone reading that file — the dashboard's failure
              screen, or whoever is on a support call — would conclude the API had never
              come up, while it was serving perfectly.

              The counter reset still belongs behind that condition; the announcement
              does not.
            */
            if started.elapsed() >= RUNNING_AFTER && !announced_healthy {
                announced_healthy = true;
                write_status(paths, "running", 0, None);
            }

            // Separately, and later: a child that has stayed up this long clears the
            // record of whatever killed the previous one.
            if started.elapsed() >= HEALTHY_AFTER && identical != 0 {
                identical = 0;
                last_signature = None;
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_status = status.to_string();
                    if status.code() == Some(RESTART_EXIT_CODE) {
                        log_line(&paths.logs, "api asked to be restarted (applying a restore)");
                        restart_requested = true;
                        break;
                    }
                    log_line(&paths.logs, &format!("api exited unexpectedly: {status}"));
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    log_line(&paths.logs, &format!("try_wait failed: {error}"));
                    exit_status = format!("try_wait failed: {error}");
                    break;
                }
            }
        }

        if restart_requested {
            // Deliberate and immediate: a restart the API asked for is not a failure,
            // and must not inherit the backoff or the count of a real one.
            identical = 0;
            last_signature = None;
            backoff = Duration::from_secs(2);
            continue;
        }

        // The child's own explanation, if it managed to leave one. This is the whole
        // point of the exercise: an exit code tells a merchant nothing, and the API
        // already writes a sentence that tells him exactly what to do.
        let reason = read_child_startup_error(paths);
        let signature = format!("{}|{}", exit_status, reason.clone().unwrap_or_default());

        if Some(&signature) == last_signature.as_ref() {
            identical += 1;
        } else {
            identical = 1;
            last_signature = Some(signature);
        }

        if started.elapsed() >= HEALTHY_AFTER {
            // It ran long enough to count as healthy before dying: treat this as a new
            // fault rather than a repeat, and reset the backoff.
            backoff = Duration::from_secs(2);
            identical = 1;
        }

        if identical >= IDENTICAL_FAILURES_BEFORE_GIVING_UP {
            let detail = reason.clone().unwrap_or_else(|| exit_status.clone());
            log_line(
                &paths.logs,
                &format!(
                    "api failed {identical} times with the same error — giving up. {detail}"
                ),
            );
            write_status(paths, "terminal", identical, Some(&detail));

            // Park until asked to stop. Deliberately not exiting the process: the SCM
            // would restart the service and the loop would begin again, which is the
            // behaviour being removed. Staying up keeps `status.json` accurate and the
            // service controllable.
            match stop.recv() {
                Ok(()) | Err(_) => return,
            }
        }

        write_status(paths, "failed", identical, reason.as_deref());
        log_line(
            &paths.logs,
            &format!("restarting api in {} seconds", backoff.as_secs()),
        );
        match stop.recv_timeout(backoff) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Service entry points
// ─────────────────────────────────────────────────────────────────────────────────

define_windows_service!(ffi_service_main, service_main);

fn service_main(_arguments: Vec<OsString>) {
    let paths = match Paths::resolve() {
        Ok(paths) => paths,
        Err(_) => return,
    };
    if let Err(error) = run_service(&paths) {
        log_line(&paths.logs, &format!("service failed: {error}"));
    }
}

fn run_service(paths: &Paths) -> Result<(), windows_service::Error> {
    paths.ensure_directories().ok();
    // Re-applied on every start, not only at install: machines already in the field
    // have a log directory locked by the old rule, and they are precisely the ones
    // where somebody is about to need to read it. Cheap, idempotent, and it repairs
    // an installation without a reinstall.
    relax_log_directory(&paths.logs);
    log_line(&paths.logs, "service starting");

    let (stop_tx, stop_rx) = mpsc::channel();

    let event_handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

    let running = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        // Shutdown as well as Stop: the machine being switched off at closing time is
        // the ordinary case here, not an edge case.
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    status_handle.set_service_status(running.clone())?;

    supervise(paths, stop_rx);

    status_handle.set_service_status(ServiceStatus {
        current_state: ServiceState::StopPending,
        controls_accepted: ServiceControlAccept::empty(),
        wait_hint: STOP_GRACE,
        ..running.clone()
    })?;
    status_handle.set_service_status(ServiceStatus {
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        ..running
    })?;

    log_line(&paths.logs, "service stopped");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Installation
// ─────────────────────────────────────────────────────────────────────────────────

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes `loyalty-pro.env` from the shipped template, with secrets generated for this one
/// installation.
///
/// Per-installation secrets matter more than they look: a signing key baked into the
/// installer would be identical in every shop, so a token minted on one merchant's
/// machine would be accepted by every other. An existing file is never overwritten —
/// rotating `QR_TOKEN_SECRET` would invalidate every loyalty card already printed.
fn ensure_env_file(paths: &Paths, port: Option<u16>) -> Result<bool, String> {
    if paths.env_file.exists() {
        /*
          ── An existing configuration this process cannot read ───────────────────

          A demo build once ran the production ACL lockdown on a per-user install,
          leaving `loyalty-pro.env` owned by SYSTEM and Administrators inside the user's own
          profile. Every later launch then did the worst possible thing: saw the file,
          declined to rewrite it, and handed the API a configuration it could not open.
          The API died on env validation, the merchant saw a product that would not
          start, and the file could not be deleted without elevation — so the machine
          never recovered on its own.

          The rule that protects the file is right and stays: `QR_TOKEN_SECRET` must
          never be regenerated, because rotating it invalidates every loyalty card
          already printed. But that rule protects a file we can READ. One we cannot is
          not a configuration at all, and keeping it costs the whole product.

          So: demo only, and only when it is genuinely unreadable, the file is replaced.
          A demo has no printed cards to invalidate and its sessions are worthless. A
          production install is never touched — there, an unreadable `loyalty-pro.env` is a
          real operator problem and silently minting new signing keys would be a far
          worse answer than refusing with a clear one.
        */
        if let Err(error) = fs::read_to_string(&paths.env_file) {
            if !paths.is_demo() {
                log_line(
                    &paths.logs,
                    &format!("cannot read {}: {error}", paths.env_file.display()),
                );
                return Err(concat!(
                    "تعذّر تشغيل الخدمة: ملف إعدادات البرنامج موجود لكن لا يمكن قراءته. ",
                    "بيانات المتجر لم تتغيّر. لا تحذف الملف — حذفه يُبطل كل بطاقات الولاء المطبوعة. ",
                    "تواصل مع الدعم الفني."
                )
                .to_string());
            }

            log_line(
                &paths.logs,
                &format!(
                    "cannot read {}: {error} — replacing it (demo build)",
                    paths.env_file.display()
                ),
            );

            // Deleting a file whose own ACL denies us still succeeds when the parent
            // directory grants FILE_DELETE_CHILD, which it does when the app created
            // it. If even that fails there is nothing this process can do, and saying
            // so precisely is worth more than a generic failure downstream.
            if let Err(remove) = fs::remove_file(&paths.env_file) {
                return Err(format!(
                    "الملف «{}» غير قابل للقراءة ولا للحذف من هذا الحساب ({remove}). أغلق البرنامج، احذف هذا الملف يدوياً بصلاحيات المدير، ثم افتح البرنامج من جديد.",
                    paths.env_file.display()
                ));
            }
            // Fall through and write a fresh one.
        } else {
            repair_database_url(paths);
            return Ok(false);
        }
    }

    /*
      ── A LOST configuration beside an EXISTING database is refused ────────────

      Everything below this point generates three fresh secrets. That is exactly right
      on a new machine and catastrophic on a machine that already has a shop on it:

        · `QR_TOKEN_SECRET` signs every loyalty card ever printed. Rotate it and every
          card in every customer's wallet stops resolving — the barcodes are still
          there, the customers still hold them, and the till says the card is unknown.
        · `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` sign every session. Rotate them and
          every till and every dashboard is signed out at once.

      None of that is recoverable, and none of it announces itself: the service starts,
      the dashboard opens, and the damage is discovered by a customer at a counter.

      The rule that `ensure_env_file` never OVERWRITES an existing file was written for
      exactly this reason. What it did not cover is the file being GONE — a restore that
      copied `loyalty-pro.db` and not `loyalty-pro.env`, a data directory moved by hand, an
      antivirus quarantine — where the same code path silently mints a new identity for
      a shop that already has one.

      So: a database present with no configuration beside it is not a first run. It is a
      configuration that has been lost, and the answer is to say so and stop. Restoring
      the file — or a backup taken with it — keeps the cards working; generating new
      secrets does not, and cannot be undone.
    */
    if paths.database().exists() && !paths.is_demo() {
        log_line(
            &paths.logs,
            &format!(
                "refusing to generate new secrets: {} exists but {} does not",
                paths.database().display(),
                paths.env_file.display()
            ),
        );
        return Err(
            "تعذّر تشغيل الخدمة: ملف إعدادات البرنامج مفقود، لكن قاعدة بيانات المتجر موجودة على هذا الجهاز. لم يُنشأ ملف جديد ولم تتغيّر بياناتك. إنشاء إعدادات جديدة هنا سيُبطل كل بطاقات الولاء المطبوعة وكل الجلسات المفتوحة، ولا يمكن التراجع عنه. تواصل مع الدعم الفني لاستعادة ملف الإعدادات — إعادة تثبيت البرنامج لن تعيده."
                .to_string(),
        );
    }

    let template_path = paths.program.join("loyalty-pro.env.template");
    let template = fs::read_to_string(&template_path)
        .map_err(|e| format!("read {}: {e}", template_path.display()))?;

    let mut contents = template
        .replace("{{DATABASE_FILE}}", &forward_slashes(&paths.database()))
        .replace("{{DATA_DIR}}", &paths.data.display().to_string().replace('\\', "/"))
        .replace("{{JWT_ACCESS_SECRET}}", &random_secret())
        .replace("{{JWT_REFRESH_SECRET}}", &random_secret())
        .replace("{{QR_TOKEN_SECRET}}", &random_secret());

    if let Some(port) = port {
        /*
          ── Rewritten by line prefix, not by matching the default ───────────────

          This was `replace("API_PORT=4100", …)`, which silently coupled two files: the
          moment `packaging/loyalty-pro.env.template` ships a different default, the match
          finds nothing, the substitution no-ops, and the service binds 4100 while the
          installer's firewall rule, the status file and the dashboard all expect the
          port that was asked for. Nothing fails; the machine simply cannot be reached,
          and the reason is a string that used to be in two places and now is not.

          Matching the KEY is the same rule `set_configured_port` already uses, and it
          holds whatever the template's default becomes.
        */
        contents = contents
            .lines()
            .map(|line| {
                if line.trim_start().starts_with("API_PORT=") {
                    format!("API_PORT={port}")
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        contents.push('\n');
    }

    fs::write(&paths.env_file, contents)
        .map_err(|e| format!("write {}: {e}", paths.env_file.display()))?;

    /*
      ── Locking the file down is right for a service and wrong for a demo ──────

      `restrict_permissions` strips inheritance and grants only SYSTEM and
      Administrators. That is correct for a production install, where the API runs as
      LocalSystem and the file holds the JWT signing keys and the QR token secret:
      anybody who can read them can mint a valid staff token on the shop's network.

      Applied to a per-user demo it locks the application out of its own
      configuration. The demo's API runs as the logged-on user, not SYSTEM, so after
      this call the process could not read the file it had just written — the env
      validator reported `DATABASE_URL: Required` against a file sitting right there,
      1006 bytes, fully populated. A hardening step calibrated for one deployment
      shape, applied unconditionally to another.

      It is also unnecessary there: the file lives under `%LOCALAPPDATA%`, inside the
      user's own profile, which other standard users cannot read anyway. The ACL
      surgery bought nothing and cost the product its ability to start at all.
    */
    if paths.is_demo() {
        println!("  permissions:   left to the user profile (per-user install)");
    } else {
        restrict_permissions(&paths.env_file);
    }
    Ok(true)
}

/// Writes paths the way SQLite's `file:` URL wants them, on a platform that does not.
fn forward_slashes(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// Points an EXISTING `loyalty-pro.env` at the database this build actually opens.
///
/// ── Why an upgrade has to touch a file that is otherwise never rewritten ─────
///
/// `ensure_env_file` refuses to overwrite an existing configuration, and that rule is
/// load-bearing: regenerating `QR_TOKEN_SECRET` would invalidate every loyalty card
/// already printed. But the demo and production builds now open differently-named
/// databases, and a machine carrying an older `loyalty-pro.env` has the old single name
/// baked into it. Left alone, that install would come up, hit the runtime guard, and
/// refuse to start — technically correct and useless to the merchant.
///
/// So exactly one line is rewritten, only when it disagrees, and the change is logged.
/// The secrets are not touched, which is the property that mattered.
fn repair_database_url(paths: &Paths) {
    let text = match fs::read_to_string(&paths.env_file) {
        Ok(text) => text,
        Err(error) => {
            /*
              An existing configuration this process cannot read.

              Previously a silent early return, which is the "silently inherited"
              failure in miniature: the file is there, so `ensure_env_file` declines to
              rewrite it, and nothing else looks at it — the API then fails validation
              on variables that are present but unreadable, and no surface says why.
              A machine in that state never recovers on its own.

              It is reachable in practice: a per-user demo installed over a data
              directory whose `loyalty-pro.env` was locked to SYSTEM by an earlier build.
            */
            log_line(
                &paths.logs,
                &format!(
                    "cannot read {}: {error} — the API will not be able to read it either.                      Do not delete it: a regenerated file rotates QR_TOKEN_SECRET and invalidates every printed card. Restore read access for SYSTEM instead.",
                    paths.env_file.display()
                ),
            );
            return;
        }
    };
    let wanted = format!("DATABASE_URL=\"file:{}\"", forward_slashes(&paths.database()));

    let mut changed = false;
    let repaired: Vec<String> = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("DATABASE_URL=") && line.trim() != wanted {
                changed = true;
                wanted.clone()
            } else {
                line.to_string()
            }
        })
        .collect();

    if !changed {
        return;
    }
    if fs::write(&paths.env_file, repaired.join("\r\n") + "\r\n").is_ok() {
        log_line(
            &paths.logs,
            &format!(
                "configuration updated: DATABASE_URL now points at {}",
                paths.database().display()
            ),
        );
    }
}

/// Rewrites `API_PORT` in an existing configuration.
///
/// A service installation fixes its port once, at install time, and opens a firewall
/// rule for it. The demo has neither: it is per-user, it cannot write a firewall rule
/// without elevation, and the port it used yesterday may belong to something else
/// today. So the launcher picks a free one at every start and this records it, so the
/// API and whoever asks `configured_port` are reading the same number.
fn set_configured_port(paths: &Paths, port: u16) {
    let Ok(text) = fs::read_to_string(&paths.env_file) else {
        return;
    };
    let wanted = format!("API_PORT={port}");

    let mut changed = false;
    let repaired: Vec<String> = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("API_PORT=") && line.trim() != wanted {
                changed = true;
                wanted.clone()
            } else {
                line.to_string()
            }
        })
        .collect();

    if changed {
        let _ = fs::write(&paths.env_file, repaired.join("\r\n") + "\r\n");
    }
}

/// Locks the whole data directory to SYSTEM and Administrators.
///
/// **This is not optional.** `%PROGRAMDATA%` grants `BUILTIN\\Users:(OI)(CI)(RX)` and
/// every file created underneath inherits it — measured on this machine, not assumed.
/// The database holds customer names and phone numbers, so without this any account
/// on the shop's PC could copy the entire customer list. §7 calls the phone number the
/// one identifier the system stores; a file the whole machine can read is not storing
/// it carefully.
///
/// Removing inheritance on the directory re-propagates to existing children, so this
/// covers `loyalty-pro.db` and its WAL sidecars. The service account is SYSTEM and the
/// dashboard reaches its data over HTTP, so no other identity needs access to those.
///
/// **The logs are deliberately exempted — see `relax_log_directory`.** They used to be
/// swept up by this lockdown, on the argument that a log can carry a request payload.
/// That argument protects the DATABASE; applied to the logs it produced a shop whose
/// owner cannot read why his own software failed, and a support call that cannot
/// either. The correct split is: the data stays locked, the logs become readable, and
/// nothing that identifies a customer is ever written to them in the first place.
fn restrict_directory(path: &Path) {
    let result = Command::new("icacls")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)(F)", // LocalSystem — the service account
            "/grant:r",
            "*S-1-5-32-544:(OI)(CI)(F)", // BUILTIN\\Administrators
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            println!("  permissions:   {} locked to SYSTEM and Administrators", path.display());
        }
        Ok(output) => eprintln!(
            "warning: could not restrict {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => eprintln!("warning: could not run icacls: {error}"),
    }
}

/// Grants the interactive user read access to the log directory.
///
/// ── Why this is a separate, deliberate hole in the lockdown ──────────────────
///
/// `restrict_directory` locks `%PROGRAMDATA%\Walaa` to SYSTEM and Administrators
/// because the database in it holds every customer's phone number. The logs inherited
/// that, and the consequence only became visible when this software failed on the
/// operator's own machine: the service was running, nothing was listening, and
/// **neither he nor anyone helping him could read a single line explaining why.**
/// Diagnosing it needed an elevated prompt on a machine whose owner may not have one,
/// in a shop, at the till, with a queue.
///
/// A log nobody can read is not a safety feature. So the two concerns are separated:
///
///   - the database, the WAL sidecars and `loyalty-pro.env` stay SYSTEM + Administrators
///   - `logs\` gets `INTERACTIVE` **read and execute** — no write, so a log cannot be
///     tampered with to hide something, only read
///
/// `S-1-5-4` (INTERACTIVE) rather than `Users`: it grants to whoever is physically
/// logged on at the machine, which is exactly the person who needs it, and not to a
/// service account or a remote session.
///
/// **This is only safe because of what is NOT in the logs.** `service.log` carries
/// exit statuses, PIDs and filesystem paths. `api.log` carries request lines whose
/// query values are redacted by `REDACTED_QUERY_PARAMS` in `app.ts` — added in the
/// same change as this one, after an audit found that every customer phone lookup was
/// being written out verbatim. If a future change logs a name, a phone or a secret,
/// this grant becomes a disclosure. The audit comes first; the permission second.
fn relax_log_directory(path: &Path) {
    let result = Command::new("icacls")
        .arg(path)
        .args([
            "/grant:r",
            "*S-1-5-4:(OI)(CI)(RX)", // INTERACTIVE — whoever is logged on at the machine
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            println!(
                "  permissions:   {} readable by the logged-on user (read only)",
                path.display()
            );
        }
        Ok(output) => eprintln!(
            "warning: could not relax {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => eprintln!("warning: could not run icacls: {error}"),
    }
}

/// Strips inherited access from the configuration file so only SYSTEM and
/// Administrators can read it.
///
/// `%PROGRAMDATA%` grants read to every local user by default, and this file holds
/// the JWT signing keys and the QR token secret. Anyone able to read them can mint a
/// valid staff token on the shop's own network.
fn restrict_permissions(path: &Path) {
    let result = Command::new("icacls")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(F)", // LocalSystem — the service account
            "/grant:r",
            "*S-1-5-32-544:(F)", // BUILTIN\Administrators
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    if let Ok(output) = result {
        if !output.status.success() {
            eprintln!(
                "warning: could not restrict permissions on {}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
    }
}

/// The port the API is actually being served on, once anything knows it.
///
/// Published by `write_status` so the manager dashboard can find its own backend with
/// nothing configured. Deliberately a `OnceLock` rather than a recomputation: the port
/// is fixed for the life of the process, and reading it from a file on every status
/// write would reintroduce exactly the failure this closes — a status file that
/// disagrees with the port the API bound.
static SERVING_PORT: OnceLock<u16> = OnceLock::new();

/// Records the port the API is being run on. First writer wins.
fn remember_serving_port(port: u16) {
    let _ = SERVING_PORT.set(port);
}

/// `API_PORT` from the configuration, or `None` when it cannot be read.
///
/// ── Why this exists separately from `configured_port` ────────────────────────
///
/// `configured_port` substitutes 4000 when the file cannot be read, because its caller
/// — the firewall rule — must open *some* port and the template's default is the best
/// available guess. Publishing that same guess to the dashboard would be strictly
/// worse than publishing nothing: the app would connect to a port the API is not
/// listening on and report a dead backend, which is a confident wrong answer in a
/// place where "I do not know" is a correct one and produces the right next step.
///
/// The file being unreadable is not hypothetical. `restrict_permissions` locks
/// `loyalty-pro.env` to SYSTEM and Administrators because it holds the JWT signing keys, so
/// any caller that is not the service account reads nothing here.
fn configured_port_opt(paths: &Paths) -> Option<u16> {
    fs::read_to_string(&paths.env_file).ok().and_then(|text| {
        text.lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("API_PORT="))
            .and_then(|value| value.trim().trim_matches('"').parse().ok())
    })
}

/// Reads `API_PORT` back out of the configuration, so the firewall rule always
/// matches what the service will actually listen on.
fn configured_port(paths: &Paths, fallback: Option<u16>) -> u16 {
    configured_port_opt(paths).or(fallback).unwrap_or(4100)
}

/// Opens the API port for the local network.
///
/// The Loyalty Station is a tablet on the shop's LAN browsing to this machine
/// (§12.3), and Windows Firewall blocks that by default — without this rule the
/// station simply never connects and the failure looks like a broken app.
///
/// **Private and domain profiles only.** A shop network classified as "Public" will
/// not match, which is deliberate: opening a listening port on an unknown network is
/// a different decision from opening it on the shop's own. The setup guide covers
/// checking the profile.
fn ensure_firewall_rule(port: u16) {
    // Delete first so re-running the installer with a different port cannot leave a
    // stale rule holding the old one open.
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule"])
        .arg(format!("name={FIREWALL_RULE}"))
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let result = Command::new("netsh")
        .args(["advfirewall", "firewall", "add", "rule"])
        .arg(format!("name={FIREWALL_RULE}"))
        .args(["dir=in", "action=allow", "protocol=TCP"])
        .arg(format!("localport={port}"))
        .args(["profile=private,domain"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            println!("  firewall:      inbound TCP {port} allowed on private networks");
        }
        Ok(output) => eprintln!(
            "warning: firewall rule not added: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        ),
        Err(error) => eprintln!("warning: could not run netsh: {error}"),
    }
}

fn remove_firewall_rule() {
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule"])
        .arg(format!("name={FIREWALL_RULE}"))
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

fn install(paths: &Paths, port: Option<u16>, delayed: bool) -> Result<(), String> {
    paths.ensure_directories()?;

    let created = ensure_env_file(paths, port)?;
    println!(
        "  configuration: {} ({})",
        paths.env_file.display(),
        if created { "created" } else { "kept existing" }
    );

    // After the configuration is written, not before. Locking the directory first would
    // strip the running installer's own access along with everyone else's, which is
    // survivable for an elevated process (Administrators keep Full control) but depends
    // on the caller's token for no benefit — the configuration file carries its own
    // explicit ACL from the moment it is created, so nothing is exposed by this order.
    //
    // Everything created here afterwards inherits the lockdown: the database and its
    // WAL sidecars.
    restrict_directory(&paths.data);
    // …except the logs, which are opened back up immediately. Order matters: the
    // lockdown strips inheritance across the whole tree, so the grant has to follow it.
    let _ = fs::create_dir_all(&paths.logs);
    relax_log_directory(&paths.logs);

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)
        .map_err(|e| format!("open service manager (run as Administrator): {e}"))?;

    let executable = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        // The station and the capture agent must find the API up after a power cut,
        // with nobody logged in.
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: executable,
        // The data directory is fixed at install time rather than rediscovered at
        // boot, so moving %PROGRAMDATA% later cannot silently point the service at an
        // empty database.
        launch_arguments: vec![
            OsString::from("run"),
            OsString::from("--data-dir"),
            paths.data.clone().into_os_string(),
        ],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let service = manager
        .create_service(
            &service_info,
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .map_err(|e| format!("create service: {e}"))?;

    service
        .set_description(DESCRIPTION)
        .map_err(|e| format!("set description: {e}"))?;

    // Plain automatic start is the default, and the reasoning is worth keeping: the
    // service binds a socket and opens a file, depending on nothing that arrives late
    // in boot, and it reports RUNNING to the SCM before it spawns anything — so it
    // cannot trip the 30-second start timeout, and a child that fails early is retried
    // by the supervisor rather than left dead. A shop opening in the morning wants the
    // API up at boot, not two minutes later, which is what delayed start costs.
    //
    // `--delayed` exists for the machine that disagrees. If a merchant's PC turns out
    // to start the service before something it needs (an antivirus filter driver
    // holding the disk, a domain profile that has not applied), this moves it after
    // the boot rush without a rebuild. `sc config LoyaltyProApi start= delayed-auto` does
    // the same thing on an already-installed machine.
    if delayed {
        service
            .set_delayed_auto_start(true)
            .map_err(|e| format!("set delayed auto-start: {e}"))?;
    }

    // Restart on failure. Without this a crash loop ends after the first crash and
    // the shop discovers it when a customer is already at the till.
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(5),
                },
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(15),
                },
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(60),
                },
            ]),
        })
        .map_err(|e| format!("set failure actions: {e}"))?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .map_err(|e| format!("set failure action flag: {e}"))?;

    println!(
        "  service:       {SERVICE_NAME} registered ({})",
        if delayed { "automatic — delayed start" } else { "automatic start" }
    );
    ensure_firewall_rule(configured_port(paths, port));
    println!("  data:          {}", paths.data.display());
    println!("  logs:          {}", paths.logs.display());
    Ok(())
}

fn uninstall(paths: &Paths) -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("open service manager (run as Administrator): {e}"))?;

    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(service) => service,
        Err(_) => {
            println!("  service {SERVICE_NAME} is not registered — nothing to remove");
            return Ok(());
        }
    };

    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            let _ = service.stop();
            let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(5);
            while Instant::now() < deadline {
                match service.query_status() {
                    Ok(s) if s.current_state == ServiceState::Stopped => break,
                    _ => std::thread::sleep(Duration::from_millis(300)),
                }
            }
        }
    }

    service.delete().map_err(|e| format!("delete service: {e}"))?;
    remove_firewall_rule();

    // The database is never removed here. An uninstall during an upgrade must not
    // take a shop's customers and transactions with it; deleting data is a decision
    // for a human with a backup in hand.
    println!("  service {SERVICE_NAME} removed");
    println!("  data kept at {} (delete by hand if intended)", paths.data.display());
    Ok(())
}

fn control(action: &str) -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("open service manager: {e}"))?;

    let access = match action {
        "start" => ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        "stop" => ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
        _ => ServiceAccess::QUERY_STATUS,
    };

    let service = manager
        .open_service(SERVICE_NAME, access)
        .map_err(|e| format!("open service {SERVICE_NAME}: {e}"))?;

    match action {
        "start" => {
            service
                .start::<&str>(&[])
                .map_err(|e| format!("start service: {e}"))?;
            println!("  {SERVICE_NAME} starting");
        }
        "stop" => {
            service.stop().map_err(|e| format!("stop service: {e}"))?;
            println!("  {SERVICE_NAME} stopping");
        }
        _ => {
            let status = service
                .query_status()
                .map_err(|e| format!("query status: {e}"))?;
            println!("  {SERVICE_NAME}: {:?}", status.current_state);
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────────

fn usage() {
    println!(
        "\nloyalty-pro-service — Windows Service host for the Walaa API\n\n\
         USAGE:\n  \
         loyalty-pro-service install [--data-dir <path>] [--port <n>] [--delayed]
                                                                  register and configure (Administrator)\n  \
         loyalty-pro-service uninstall [--data-dir <path>]              stop and deregister; keeps the data\n  \
         loyalty-pro-service start | stop | status                      control the registered service\n  \
         loyalty-pro-service console [--data-dir <path>]                run in the foreground (diagnostics)\n  \
         loyalty-pro-service run                                        the Service Control Manager entry point\n"
    );
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();

    let mut data_dir: Option<PathBuf> = None;
    let mut port: Option<u16> = None;
    let mut delayed = false;
    let mut index = 1;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--data-dir" if index + 1 < arguments.len() => {
                data_dir = Some(PathBuf::from(&arguments[index + 1]));
                index += 2;
            }
            "--port" if index + 1 < arguments.len() => {
                port = arguments[index + 1].parse().ok();
                index += 2;
            }
            "--delayed" => {
                delayed = true;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if let Some(dir) = data_dir {
        let _ = DATA_DIR_OVERRIDE.set(dir);
    }

    let paths = match Paths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    };

    let command = arguments.first().map(String::as_str).unwrap_or("");
    let result = match command {
        "run" => service_dispatcher::start(SERVICE_NAME, ffi_service_main)
            .map_err(|e| format!("service dispatcher: {e} (use `console` to run in a terminal)")),
        "install" => install(&paths, port, delayed),
        "uninstall" => uninstall(&paths),
        "start" | "stop" | "status" => control(command),
        "console" => {
            if let Err(error) = paths.ensure_directories() {
                eprintln!("error: {error}");
                std::process::exit(1);
            }

            /*
              ── Console mode is the demo build's launcher, not just a diagnostic ──

              The demo runs the API under the app instead of under the Service Control
              Manager, because a per-user install must not need UAC and cannot register
              a service. What it must NOT do is run a second, simpler supervisor: the
              whole point of exercising the demo is to exercise what the merchant's real
              install does, and two supervisors would mean the demo proves nothing about
              production. So both launchers converge on `supervise()` below, and this
              arm's only extra job is the provisioning the SCM path gets from `install`.

              `--port` is honoured and REWRITTEN on every launch here, unlike a service
              installation where the port is fixed at install time. A per-user demo has
              no reserved port and no firewall rule; it takes whatever is free when the
              merchant opens it.
            */
            if let Err(error) = ensure_env_file(&paths, port) {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
            if let Some(port) = port {
                set_configured_port(&paths, port);
                // Authoritative, and recorded before `supervise` falls back to reading
                // the file: this launcher chose the number, so it need not re-derive it
                // from a file it may not be able to read.
                remember_serving_port(port);
            }

            println!("  running in the foreground. Ctrl+C to stop.");
            println!("  data: {}", paths.data.display());
            println!("  logs: {}", paths.logs.display());
            println!("  port: {}", configured_port(&paths, port));

            let (stop_tx, stop_rx) = mpsc::channel();
            ctrlc_handler(stop_tx);
            supervise(&paths, stop_rx);
            Ok(())
        }
        _ => {
            usage();
            Ok(())
        }
    };

    if let Err(error) = result {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

/// Ctrl+C in console mode. A second press falls through to the default handler, so a
/// wedged shutdown can still be interrupted.
fn ctrlc_handler(sender: mpsc::Sender<()>) {
    std::thread::spawn(move || {
        let mut line = String::new();
        // Blocking on stdin is how a foreground run waits: closing the console closes
        // stdin, and typing anything followed by Enter also stops it. Console mode is
        // a diagnostic tool, not the production path.
        let _ = std::io::stdin().read_line(&mut line);
        let _ = sender.send(());
    });
}


// ─────────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The load-bearing assumption behind [`rotate_running_if_large`].
    ///
    /// The API child holds an inherited APPEND handle to `api.log` for its whole life.
    /// This asserts that truncating the file underneath that handle actually shrinks it
    /// and that subsequent writes resume at zero — rather than leaving a multi-megabyte
    /// sparse hole, which is what would happen through a plain write handle that kept its
    /// old offset. It is Windows file-handle behaviour, not something the type system
    /// checks, so it is pinned here.
    #[test]
    fn truncating_under_an_open_append_handle_resets_the_file() {
        let dir = std::env::temp_dir().join(format!("walaa-rotate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("api.log");

        // Stand in for the child: an append handle held open across the rotation.
        let mut held = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .unwrap();

        held.write_all(&vec![b'x'; 4096]).unwrap();
        held.flush().unwrap();

        rotate_running_if_large(&log, 1024);

        // The previous generation was kept ...
        assert_eq!(fs::metadata(log.with_extension("log.1")).unwrap().len(), 4096);
        // ... and the live file was emptied, not renamed away.
        assert_eq!(fs::metadata(&log).unwrap().len(), 0);

        // The handle the "child" still holds keeps working, and writes land at the start
        // of the truncated file rather than 4 KB into a sparse one.
        held.write_all(b"after").unwrap();
        held.flush().unwrap();
        assert_eq!(fs::metadata(&log).unwrap().len(), 5);
        assert_eq!(fs::read_to_string(&log).unwrap(), "after");

        drop(held);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A log under the cap is left alone — no spurious generation, no lost lines.
    #[test]
    fn a_small_log_is_not_rotated() {
        let dir = std::env::temp_dir().join(format!("walaa-rotate-small-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("api.log");
        fs::write(&log, "short").unwrap();

        rotate_running_if_large(&log, 1024);

        assert_eq!(fs::read_to_string(&log).unwrap(), "short");
        assert!(!log.with_extension("log.1").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A scratch install: a program directory with a template, and a data directory.
    fn scratch_install(name: &str) -> Paths {
        let root = std::env::temp_dir().join(format!("walaa-env-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let program = root.join("program");
        let data = root.join("data");
        fs::create_dir_all(&program).unwrap();
        fs::create_dir_all(data.join("logs")).unwrap();
        fs::write(
            program.join("loyalty-pro.env.template"),
            "NODE_ENV=production
DATABASE_URL=\"file:{{DATABASE_FILE}}\"
API_PORT=4100
             JWT_ACCESS_SECRET={{JWT_ACCESS_SECRET}}
JWT_REFRESH_SECRET={{JWT_REFRESH_SECRET}}
             QR_TOKEN_SECRET={{QR_TOKEN_SECRET}}
",
        )
        .unwrap();
        Paths {
            env_file: data.join("loyalty-pro.env"),
            logs: data.join("logs"),
            migrations: program.join("migrations"),
            program,
            data,
        }
    }

    /// A genuinely new machine still gets its own secrets — the case the guard below
    /// must not break.
    ///
    /// The CONTENT is asserted on the demo path below rather than here. A production
    /// install ends with `restrict_permissions`, which strips inheritance and grants
    /// SYSTEM and Administrators only, so this test process cannot read back the file
    /// it just caused to be written. Asserting "the read fails" instead would be a test
    /// of whether the runner happens to be elevated, which is a test of the environment
    /// and not of this code.
    #[test]
    fn a_first_run_with_no_database_generates_a_configuration() {
        let paths = scratch_install("fresh");
        assert!(ensure_env_file(&paths, Some(4321)).unwrap());
        assert!(fs::metadata(&paths.env_file).unwrap().len() > 0);

        let _ = fs::remove_dir_all(paths.data.parent().unwrap());
    }

    /// The substitution itself, on the path where the file stays readable.
    ///
    /// `is_demo()` is decided by the seed database beside the program, and a demo
    /// install skips the ACL lockdown deliberately (it runs as the logged-on user, and
    /// locking it out of its own configuration is a defect this project has already had
    /// once). Same `ensure_env_file`, same substitution, readable afterwards.
    #[test]
    fn every_placeholder_is_substituted_and_the_port_is_the_one_asked_for() {
        let paths = scratch_install("substitution");
        fs::write(paths.demo_seed(), b"demo seed").unwrap();
        assert!(paths.is_demo());

        assert!(ensure_env_file(&paths, Some(4321)).unwrap());

        let written = fs::read_to_string(&paths.env_file).unwrap();
        assert!(written.contains("API_PORT=4321"));
        assert!(!written.contains("{{"), "a placeholder survived: {written}");
        // Three DIFFERENT secrets, not one value used three times.
        let secrets: Vec<&str> = written
            .lines()
            .filter(|l| l.contains("_SECRET="))
            .map(|l| l.split_once('=').unwrap().1)
            .collect();
        assert_eq!(secrets.len(), 3);
        assert_eq!(
            secrets.iter().collect::<std::collections::HashSet<_>>().len(),
            3,
        );

        let _ = fs::remove_dir_all(paths.data.parent().unwrap());
    }

    /// ── The one that matters ────────────────────────────────────────────────
    ///
    /// `loyalty-pro.env` gone, `loyalty-pro.db` still there — a restore that copied the database
    /// and not the configuration, a directory moved by hand, an antivirus quarantine.
    /// Generating fresh secrets here rotates `QR_TOKEN_SECRET`, which invalidates every
    /// loyalty card ever printed, silently and irreversibly. It must refuse.
    #[test]
    fn a_missing_configuration_beside_an_existing_database_is_refused() {
        let paths = scratch_install("lost-config");
        fs::write(paths.database(), b"a shop's database").unwrap();

        let refusal = ensure_env_file(&paths, Some(4321)).unwrap_err();

        // Refused with a reason, and — the actual property — nothing written.
        assert!(refusal.contains("بطاقات الولاء"));
        assert!(!paths.env_file.exists());

        let _ = fs::remove_dir_all(paths.data.parent().unwrap());
    }

    /// And an existing configuration is still never rewritten, database or not.
    #[test]
    fn an_existing_configuration_is_left_exactly_as_it_was() {
        let paths = scratch_install("existing");
        fs::write(&paths.env_file, "QR_TOKEN_SECRET=theoriginalsecret
DATABASE_URL=\"file:x\"
")
            .unwrap();
        fs::write(paths.database(), b"a shop's database").unwrap();

        assert!(!ensure_env_file(&paths, Some(4321)).unwrap());
        assert!(fs::read_to_string(&paths.env_file)
            .unwrap()
            .contains("theoriginalsecret"));

        let _ = fs::remove_dir_all(paths.data.parent().unwrap());
    }
}
