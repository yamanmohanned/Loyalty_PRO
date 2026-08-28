//! Windows Service host for the Walaa API (ولاء).
//!
//! CLAUDE_v3.md §12.3 requires the API to run as a Windows Service rather than a
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
//! signal when `WALAA_SUPERVISED=1`. If the child has not exited within
//! `STOP_GRACE`, it is terminated — SQLite is in WAL mode, so even that is safe,
//! it just costs the in-flight request.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
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

const SERVICE_NAME: &str = "WalaaApi";
const DISPLAY_NAME: &str = "Walaa Loyalty API";
/// Name of the inbound firewall rule that lets the Loyalty Station reach the API.
const FIREWALL_RULE: &str = "Walaa Loyalty API";

const DESCRIPTION: &str =
    "خدمة ولاء — واجهة البرمجة وقاعدة البيانات المحلية. Local API and SQLite datastore for the Walaa loyalty system.";

/// How long a stopping child gets to finish in-flight work before it is terminated.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// A child that stayed up this long is considered healthy; the restart backoff resets.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Rotate the API log at this size. A shop runs for years; an unbounded log is a
/// disk-full outage waiting for a quiet Tuesday.
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

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
            .or_else(|| std::env::var_os("WALAA_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(|| {
                let program_data = std::env::var_os("PROGRAMDATA")
                    .unwrap_or_else(|| OsString::from("C:\\ProgramData"));
                Path::new(&program_data).join("Walaa")
            });

        Ok(Paths {
            env_file: data.join("walaa.env"),
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
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────────────────────────

/// Appends one timestamped line to the host's own log.
///
/// Deliberately not a logging crate: this writes a handful of lines per day and the
/// file is read by a human on a support call, so a dependency-free appender that can
/// never itself fail loudly is the right size of tool.
fn log_line(logs: &Path, message: &str) {
    let _ = fs::create_dir_all(logs);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("service.log"))
    {
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
fn rotate_if_large(path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > LOG_ROTATE_BYTES {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Supervision
// ─────────────────────────────────────────────────────────────────────────────────

fn spawn_api(paths: &Paths) -> Result<Child, String> {
    let node = paths.program.join("node.exe");
    if !node.exists() {
        return Err(format!("node runtime missing: {}", node.display()));
    }

    let api_log = paths.logs.join("api.log");
    rotate_if_large(&api_log);
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&api_log)
        .map_err(|e| format!("open {}: {e}", api_log.display()))?;
    let err = out.try_clone().map_err(|e| format!("clone log handle: {e}"))?;

    Command::new(node)
        .arg("walaa-api.cjs")
        .current_dir(&paths.program)
        .env("NODE_ENV", "production")
        .env("WALAA_DATA_DIR", &paths.data)
        .env("WALAA_ENV_FILE", &paths.env_file)
        .env("WALAA_MIGRATIONS_DIR", &paths.migrations)
        .env("WALAA_SUPERVISED", "1")
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
fn supervise(paths: &Paths, stop: Receiver<()>) {
    let mut backoff = Duration::from_secs(2);

    loop {
        let started = Instant::now();
        let mut child = match spawn_api(paths) {
            Ok(child) => {
                log_line(&paths.logs, &format!("api started (pid {})", child.id()));
                child
            }
            Err(error) => {
                log_line(&paths.logs, &format!("failed to start api: {error}"));
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
        loop {
            match stop.recv_timeout(Duration::from_millis(250)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                    stop_child(&mut child, paths);
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    log_line(&paths.logs, &format!("api exited unexpectedly: {status}"));
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    log_line(&paths.logs, &format!("try_wait failed: {error}"));
                    break;
                }
            }
        }

        if started.elapsed() >= HEALTHY_AFTER {
            backoff = Duration::from_secs(2);
        }

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

/// Writes `walaa.env` from the shipped template, with secrets generated for this one
/// installation.
///
/// Per-installation secrets matter more than they look: a signing key baked into the
/// installer would be identical in every shop, so a token minted on one merchant's
/// machine would be accepted by every other. An existing file is never overwritten —
/// rotating `QR_TOKEN_SECRET` would invalidate every loyalty card already printed.
fn ensure_env_file(paths: &Paths, port: Option<u16>) -> Result<bool, String> {
    if paths.env_file.exists() {
        return Ok(false);
    }

    let template_path = paths.program.join("walaa.env.template");
    let template = fs::read_to_string(&template_path)
        .map_err(|e| format!("read {}: {e}", template_path.display()))?;

    let mut contents = template
        .replace("{{DATA_DIR}}", &paths.data.display().to_string().replace('\\', "/"))
        .replace("{{JWT_ACCESS_SECRET}}", &random_secret())
        .replace("{{JWT_REFRESH_SECRET}}", &random_secret())
        .replace("{{QR_TOKEN_SECRET}}", &random_secret());

    if let Some(port) = port {
        contents = contents.replace("API_PORT=4000", &format!("API_PORT={port}"));
    }

    fs::write(&paths.env_file, contents)
        .map_err(|e| format!("write {}: {e}", paths.env_file.display()))?;

    restrict_permissions(&paths.env_file);
    Ok(true)
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
/// covers `walaa.db`, its WAL sidecars, and the logs — which can carry a request
/// payload in an error. The service account is SYSTEM and the dashboard reaches its
/// data over HTTP, so no other identity needs access. Reading the logs during support
/// therefore needs an elevated prompt, which whoever installed the software has.
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

/// Reads `API_PORT` back out of the configuration, so the firewall rule always
/// matches what the service will actually listen on.
fn configured_port(paths: &Paths, fallback: Option<u16>) -> u16 {
    fs::read_to_string(&paths.env_file)
        .ok()
        .and_then(|text| {
            text.lines()
                .map(str::trim)
                .find_map(|line| line.strip_prefix("API_PORT="))
                .and_then(|value| value.trim().trim_matches('"').parse().ok())
        })
        .or(fallback)
        .unwrap_or(4000)
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
    // Everything created here afterwards inherits the lockdown: the database, its WAL
    // sidecars, and the logs.
    restrict_directory(&paths.data);

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
    // the boot rush without a rebuild. `sc config WalaaApi start= delayed-auto` does
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
        "\nwalaa-service — Windows Service host for the Walaa API\n\n\
         USAGE:\n  \
         walaa-service install [--data-dir <path>] [--port <n>] [--delayed]
                                                                  register and configure (Administrator)\n  \
         walaa-service uninstall [--data-dir <path>]              stop and deregister; keeps the data\n  \
         walaa-service start | stop | status                      control the registered service\n  \
         walaa-service console [--data-dir <path>]                run in the foreground (diagnostics)\n  \
         walaa-service run                                        the Service Control Manager entry point\n"
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
            println!("  running in the foreground. Ctrl+C to stop.");
            println!("  data: {}", paths.data.display());
            println!("  logs: {}", paths.logs.display());

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
