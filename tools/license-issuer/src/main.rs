//! `license-issuer` — issues ولاء licence codes.
//!
//! Holds the only copy of the private key (encrypted, beside a log of every licence
//! issued). Never shipped with the application. See README.md before first use.

mod issue;
mod keystore;
mod log;
mod password;

use std::io::{BufRead, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use chrono::{TimeZone, Utc};
use clap::{Parser, Subcommand};
use ed25519_dalek::Signer;
use loyalty_pro_license::{code, device, key_fingerprint, unlock, KeyKind};

const KEY_FILE: &str = "issuer-key.json";
const LOG_FILE: &str = "issued.db";

#[derive(Parser)]
#[command(name = "license-issuer", version, about = "Issues ولاء licence codes. Keep the key safe — see README.md.")]
struct Cli {
    /// The folder holding issuer-key.json and issued.db. Default: $LOYALTY_ISSUER_HOME, else
    /// whichever of %USERPROFILE%\.loyalty-pro-issuer and %APPDATA%\loyalty-pro-license-issuer holds a key.
    #[arg(long, global = true)]
    home: Option<PathBuf>,

    /// Read the password from standard input instead of prompting. Any shell will do:
    /// byte-order marks, UTF-16, surrounding spaces and line endings are all removed.
    #[arg(long, global = true, conflicts_with = "password_file")]
    password_stdin: bool,

    /// Read the password from this file instead of prompting (UTF-8 or UTF-16, with or
    /// without a byte-order mark or a final line ending).
    #[arg(long, global = true, value_name = "FILE")]
    password_file: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate the key pair. Once. Refuses if a key already exists in --home.
    Keygen {
        /// Where to write the Rust source file carrying the public key. Default: the
        /// repository's crates/loyalty-pro-license/src/public_key.rs.
        #[arg(long)]
        public_key_out: Option<PathBuf>,
        /// Generate a development key: builds embedding it cannot be packaged.
        #[arg(long)]
        development: bool,
    },
    /// A device's FIRST licence. A device that already has one is renewed instead.
    Issue {
        /// The device ID the merchant sent, WL-XXXX-XXXX.
        #[arg(long)]
        device: String,
        /// A trial of this many days, from now.
        #[arg(long, conflicts_with = "perpetual", required_unless_present = "perpetual")]
        days: Option<u32>,
        /// A licence that never expires.
        #[arg(long)]
        perpetual: bool,
        /// Features to grant, comma-separated. Default: drive_backup,multi_device.
        #[arg(long, value_delimiter = ',')]
        feat: Option<Vec<String>>,
        /// Store name or any note, up to 120 characters. Travels inside the code.
        #[arg(long)]
        note: Option<String>,
    },
    /// Renew a device that already has a licence: add days to the end of the licence it
    /// holds (or to today, if that has ended), or make it perpetual. The shop pastes the
    /// new code the same way; the old licence needs nothing done to it.
    Renew {
        /// The device ID, WL-XXXX-XXXX.
        #[arg(long)]
        device: String,
        /// Days to add to the end of the current licence.
        #[arg(long, conflicts_with = "perpetual", required_unless_present = "perpetual")]
        days: Option<u32>,
        /// Make the licence perpetual (the one-time payment was received).
        #[arg(long)]
        perpetual: bool,
        /// Features, comma-separated. Default: those of the licence being renewed.
        #[arg(long, value_delimiter = ',')]
        feat: Option<Vec<String>>,
        /// Note inside the code. Default: that of the licence being renewed.
        #[arg(long)]
        note: Option<String>,
    },
    /// An emergency code to read over the phone: full operation on that device at once,
    /// for 1–30 days, with no internet. Not a licence — send one when you can.
    Unlock {
        /// The device ID the merchant reads out, WL-XXXX-XXXX.
        #[arg(long)]
        device: String,
        /// How many days it keeps the shop working (through the end of that day, UTC).
        #[arg(long, default_value_t = 7)]
        days: u32,
        /// Why — kept in this issuer's log only.
        #[arg(long)]
        note: Option<String>,
    },
    /// Open the key with the password and say whether it worked. Issues nothing, writes
    /// nothing — the thing to run before leaving for a shop.
    Check,
    /// List every licence and emergency code this issuer has issued.
    List {
        /// Only this device.
        #[arg(long)]
        device: Option<String>,
    },
}

/// Where the password comes from.
enum PasswordSource {
    Prompt,
    Stdin,
    File(PathBuf),
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let home = match cli.home.clone() {
        Some(path) => Home { path, searched: None },
        None => default_home(),
    };
    let source = match (cli.password_file.clone(), cli.password_stdin) {
        (Some(path), _) => PasswordSource::File(path),
        (None, true) => PasswordSource::Stdin,
        (None, false) => PasswordSource::Prompt,
    };
    let term = |days: Option<u32>, perpetual: bool| if perpetual { issue::Term::Perpetual } else { issue::Term::Days(days.unwrap_or(0)) };
    let result = match cli.command {
        Command::Keygen { public_key_out, development } => keygen(&home.path, &source, public_key_out, development),
        Command::Issue { device, days, perpetual, feat, note } => {
            issue_command(&home, &source, IssueKind::First, &device, term(days, perpetual), feat, note)
        }
        Command::Renew { device, days, perpetual, feat, note } => {
            issue_command(&home, &source, IssueKind::Renewal, &device, term(days, perpetual), feat, note)
        }
        Command::Unlock { device, days, note } => unlock_command(&home, &source, &device, days, note),
        Command::Check => check_command(&home, &source),
        Command::List { device } => list_command(&home.path, device),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

/// The key folder, and — when it was not given — every folder looked in for it.
struct Home {
    path: PathBuf,
    searched: Option<Vec<PathBuf>>,
}

/// `$LOYALTY_ISSUER_HOME`, else the first of the usual folders that holds a key.
///
/// The default used to be `%APPDATA%\loyalty-pro-license-issuer` alone, while the provider's key
/// lives in `%USERPROFILE%\.loyalty-pro-issuer`, so every command without `--home` failed to find it.
fn default_home() -> Home {
    if let Ok(home) = std::env::var("LOYALTY_ISSUER_HOME") {
        return Home { path: PathBuf::from(home), searched: None };
    }
    let mut candidates = Vec::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        candidates.push(Path::new(&profile).join(".loyalty-pro-issuer"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(Path::new(&appdata).join("loyalty-pro-license-issuer"));
    }
    if candidates.is_empty() {
        candidates.push(PathBuf::from(".loyalty-pro-issuer"));
    }
    let path = candidates.iter().find(|c| c.join(KEY_FILE).exists()).unwrap_or(&candidates[0]).clone();
    Home { path, searched: Some(candidates) }
}

fn read_password(prompt: &str, source: &PasswordSource) -> Result<String, String> {
    match source {
        PasswordSource::File(path) => {
            let bytes = std::fs::read(path).map_err(|e| format!("reading the password file {}: {e}", path.display()))?;
            password::normalize(&bytes).map_err(|e| format!("{}: {e}", path.display()))
        }
        PasswordSource::Stdin => {
            let stdin = std::io::stdin();
            let mut bytes = Vec::new();
            if stdin.is_terminal() {
                let mut line = String::new();
                stdin.lock().read_line(&mut line).map_err(|e| e.to_string())?;
                bytes = line.into_bytes();
            } else {
                // All of it, not one line: a UTF-16 pipe carries a zero byte after its newline.
                stdin.lock().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            }
            password::normalize(&bytes).map_err(|e| format!("standard input: {e}"))
        }
        PasswordSource::Prompt => {
            if !std::io::stdin().is_terminal() {
                return Err("no terminal to prompt for the password — run this in a terminal, or pass --password-file".into());
            }
            let typed = rpassword::prompt_password(prompt).map_err(|e| e.to_string())?;
            password::normalize(typed.as_bytes())
        }
    }
}

/// Opens the key with the password as normalised — and, for a key sealed before
/// 2026-09-15 behind an invisible U+FEFF, with that mark put back.
fn open_key(file: &keystore::KeyFile, password: &str, source: &PasswordSource) -> Result<ed25519_dalek::SigningKey, String> {
    let refused = |error: String| {
        // Windows PowerShell 5.1 sends a pipe as ASCII: every other character arrives as a
        // literal '?', and no program can tell it from a real one.
        if matches!(source, PasswordSource::Stdin) && password.contains('?') {
            format!("{error} (a '?' arrived through the pipe — Windows PowerShell replaces characters it cannot send that way; use --password-file instead of a pipe)")
        } else {
            error
        }
    };
    match keystore::open(file, password) {
        Ok(signing) => Ok(signing),
        Err(error) => match keystore::open(file, &password::legacy_bom_form(password)) {
            Ok(signing) => {
                eprintln!(
                    "note: this key file was sealed with an invisible U+FEFF before its password (a key made before \
                     2026-09-15); it opened with that mark added back. Nothing to do."
                );
                Ok(signing)
            }
            Err(_) => Err(refused(error)),
        },
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn date(seconds: i64) -> String {
    Utc.timestamp_opt(seconds, 0).single().map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default()
}

fn keygen(home: &Path, source: &PasswordSource, public_key_out: Option<PathBuf>, development: bool) -> Result<(), String> {
    let key_path = home.join(KEY_FILE);
    if key_path.exists() {
        return Err(format!(
            "{} already exists. keygen runs once: a new key would make every code already issued unverifiable by the next build. \
             Move the existing file away deliberately if you really mean to start again.",
            key_path.display()
        ));
    }

    let kind = if development { KeyKind::Development } else { KeyKind::Production };
    let password = read_password("New password for the private key: ", source)?;
    if matches!(source, PasswordSource::Prompt) {
        let again = read_password("Repeat the password: ", &PasswordSource::Prompt)?;
        if again != password {
            return Err("the two passwords differ — nothing was written".into());
        }
    }
    let (mut file, signing) = keystore::generate(&password, kind, &now_iso())?;
    let public = signing.verifying_key().to_bytes();

    // The emergency-code chain: its secret comes from the private key, its tip goes
    // into the application beside the public key.
    let epoch_day = Utc::now().timestamp().div_euclid(86_400) - unlock::EPOCH_LEAD_DAYS;
    let chain = unlock::Chain::new(&unlock::chain_secret(&signing.to_bytes()), epoch_day, unlock::CHAIN_LENGTH);
    file.unlock = Some(keystore::UnlockParams::from_chain(&chain));

    let target = public_key_out.unwrap_or_else(default_public_key_file);
    if let Ok(existing) = std::fs::read_to_string(&target) {
        if existing.contains("KeyKind::Production") && !existing.contains(&rust_bytes(&public)) && kind == KeyKind::Production {
            return Err(format!(
                "{} already embeds a production key. Replacing it would make every installed copy reject every code issued before. \
                 Nothing was written.",
                target.display()
            ));
        }
    }

    std::fs::create_dir_all(home).map_err(|e| format!("creating {}: {e}", home.display()))?;
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&key_path, json).map_err(|e| format!("writing {}: {e}", key_path.display()))?;
    log::open(&home.join(LOG_FILE)).map_err(|e| format!("creating the log: {e}"))?;

    let written = match std::fs::write(&target, public_key_source(&public, kind, &chain)) {
        Ok(()) => format!("wrote the public key into {}", target.display()),
        Err(error) => format!(
            "could not write {} ({error}) — copy this into crates/loyalty-pro-license/src/public_key.rs by hand:\n\n{}",
            target.display(),
            public_key_source(&public, kind, &chain)
        ),
    };

    println!("Key pair generated ({}).", kind.as_str());
    println!("  private key (encrypted)  {}", key_path.display());
    println!("  issue log                {}", home.join(LOG_FILE).display());
    println!("  public key fingerprint   {}", key_fingerprint(&public));
    println!("  emergency codes          until {}", date(chain.valid_until(chain.length)));
    println!("  {written}");
    println!();
    println!("Back up the folder {} and the password NOW, in two separate places.", home.display());
    println!("Losing either one makes it impossible to issue any new licence — see README.md.");
    println!("Then rebuild the application so it embeds this public key.");
    Ok(())
}

fn default_public_key_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/loyalty-pro-license/src/public_key.rs")
}

fn rust_bytes(bytes: &[u8]) -> String {
    bytes
        .chunks(8)
        .map(|chunk| chunk.iter().map(|b| format!("0x{b:02x}")).collect::<Vec<_>>().join(", "))
        .collect::<Vec<_>>()
        .join(",\n    ")
}

fn public_key_source(public: &[u8; 32], kind: KeyKind, chain: &unlock::Chain) -> String {
    let kind_name = match kind {
        KeyKind::Development => "Development",
        KeyKind::Production => "Production",
    };
    format!(
        "// Written by `license-issuer keygen`. Do not edit by hand.\n\
         //\n\
         // Fingerprint {}. A development key runs and can be tested end to end, and\n\
         // `pnpm package:installer` refuses to package it (packaging/scripts/verify-license-key.mjs).\n\
         \n\
         use crate::KeyKind;\n\
         \n\
         pub const KEY_KIND: KeyKind = KeyKind::{kind_name};\n\
         \n\
         pub const PUBLIC_KEY: [u8; 32] = [\n    {},\n];\n\
         \n\
         // The emergency-code chain (crates/loyalty-pro-license/src/unlock.rs). Public values:\n\
         // phone codes are checked by hashing forward to this tip.\n\
         pub const UNLOCK_EPOCH_DAY: i64 = {};\n\
         pub const UNLOCK_CHAIN_LENGTH: u32 = {};\n\
         pub const UNLOCK_TIP: u64 = 0x{:016x};\n",
        key_fingerprint(public),
        rust_bytes(public),
        chain.epoch_day,
        chain.length,
        chain.tip
    )
}

fn load_key(home: &Home) -> Result<keystore::KeyFile, String> {
    let key_path = home.path.join(KEY_FILE);
    let text = std::fs::read_to_string(&key_path).map_err(|e| match &home.searched {
        Some(searched) if !key_path.exists() => format!(
            "no {KEY_FILE} in {} — pass --home with the folder that holds your key",
            searched.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" or ")
        ),
        _ => format!("reading {}: {e} — pass --home with the folder that holds your key", key_path.display()),
    })?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not a key file: {e}", key_path.display()))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IssueKind {
    First,
    Renewal,
}

fn issue_command(
    home: &Home,
    source: &PasswordSource,
    kind: IssueKind,
    device: &str,
    term: issue::Term,
    features: Option<Vec<String>>,
    note: Option<String>,
) -> Result<(), String> {
    let file = load_key(home)?;
    let connection = log::open(&home.path.join(LOG_FILE)).map_err(|e| format!("opening the log: {e}"))?;

    let device = loyalty_pro_license::device::normalize_device_id(device);
    let history = log::list(&connection, Some(&device)).map_err(|e| e.to_string())?;
    let current = issue::Current::from_entries(&history);
    let request = match kind {
        IssueKind::First => {
            issue::refuse_if_already_licensed(&device, current.as_ref())?;
            issue::Request { device: device.clone(), term, extend: false, features, note }
        }
        IssueKind::Renewal => issue::renewal(&device, term, features, note, current.as_ref())?,
    };
    let now = Utc::now().timestamp();
    let was = current.as_ref().and_then(|c| c.trial_until);
    let payload = issue::build(&request, now, was, uuid::Uuid::new_v4().to_string())?;

    let password = read_password("Password for the private key: ", source)?;
    let signing = open_key(&file, &password, source)?;
    let bytes = payload.to_bytes();
    let signature = signing.sign(&bytes).to_bytes();
    let license_code = code::encode(&bytes, &signature);

    // Proves the code before it is handed out: the same check the application makes.
    let public = signing.verifying_key().to_bytes();
    loyalty_pro_license::verify_with_key(&license_code, &payload.did, &public)
        .map_err(|e| format!("internal error: the new code does not verify ({})", e.code()))?;

    log::record(&connection, &payload, request.extend, &file.fingerprint, &license_code)
        .map_err(|e| format!("recording in the log: {e}"))?;

    let describe = |exp: Option<i64>| match exp {
        None => "perpetual — never expires".to_string(),
        Some(exp) => format!("trial — until {}", date(exp)),
    };
    match kind {
        IssueKind::First => {
            println!("Licence issued");
            println!("  device    {}", payload.did);
            println!("  type      {}", describe(payload.exp));
        }
        IssueKind::Renewal => {
            println!("Licence renewed");
            println!("  device    {}", payload.did);
            match was {
                Some(until) if until > now => println!("  was       trial — until {} (still running)", date(until)),
                Some(until) => println!("  was       trial — ended {}", date(until)),
                None => println!("  was       —"),
            }
            match (payload.exp, was) {
                (Some(exp), Some(until)) if until > now => {
                    println!("  now       {} (the days were added to the end of the current licence)", describe(Some(exp)))
                }
                (Some(exp), _) => println!("  now       {} (counted from today: the old licence had ended)", describe(Some(exp))),
                (None, _) => println!("  now       {}", describe(None)),
            }
        }
    }
    println!("  features  {}", if payload.feat.is_empty() { "none".to_string() } else { payload.feat.join(", ") });
    if let Some(note) = &payload.note {
        println!("  note      {note}");
    }
    println!("  licence   {}", payload.lid);
    if file.kind == KeyKind::Development.as_str() {
        println!("  WARNING   signed with a DEVELOPMENT key — only development builds accept it");
    }
    println!();
    println!("On the shop PC: Settings > Licensing > paste it into the activation code box > Activate.");
    if kind == IssueKind::Renewal {
        println!("It takes effect at once, with no restart - whether the shop is still licensed or already read-only.");
        println!("The old licence needs nothing done to it: the program runs on whichever licence lasts longest.");
    }
    // The code stays the last thing printed: scripts take everything after this line.
    println!();
    println!("Send the merchant this code (the lines can be pasted as they are):");
    println!();
    println!("{}", code::wrap(&license_code));
    Ok(())
}

fn unlock_command(home: &Home, source: &PasswordSource, device: &str, days: u32, note: Option<String>) -> Result<(), String> {
    let file = load_key(home)?;
    let chain = file
        .unlock
        .as_ref()
        .ok_or("this key file was made before emergency codes existed — it cannot issue them")?
        .chain()?;
    let device = device::normalize_device_id(device);
    if !device::is_valid_device_id(&device) {
        return Err(format!(
            "{device:?} is not a device ID — it looks like WL-XXXX-XXXX and uses only the symbols 2-9 and A-Z without I, L, O, U"
        ));
    }
    let connection = log::open(&home.path.join(LOG_FILE)).map_err(|e| format!("opening the log: {e}"))?;

    let password = read_password("Password for the private key: ", source)?;
    let signing = open_key(&file, &password, source)?;
    let secret = unlock::chain_secret(&signing.to_bytes());
    let now = Utc::now().timestamp();
    let issued = unlock::issue(&secret, &chain, &device, now, days)?;

    // The same check the application makes, before the code is read to anyone.
    unlock::verify(&issued.code, &device, &chain, now)
        .map_err(|e| format!("internal error: the new code does not verify ({})", e.code()))?;
    log::record_unlock(&connection, &device, &issued, now, note.as_deref(), &file.fingerprint)
        .map_err(|e| format!("recording in the log: {e}"))?;

    println!("Emergency code issued");
    println!("  device    {device}");
    println!("  works     until {} ({days} day{})", date(issued.valid_until), if days == 1 { "" } else { "s" });
    // The chain is a calendar: it ends on a fixed day, whatever has been issued. Say so a
    // year ahead, while there is time to ship builds that carry a new one (LICENSING.md §7).
    let chain_end = chain.valid_until(chain.length);
    let left = (chain_end - now) / 86_400;
    if left < 365 {
        println!(
            "  WARNING   this key's emergency codes end on {} — {left} days from now. Make a new chain and ship it before then.",
            date(chain_end)
        );
    }
    if file.kind == KeyKind::Development.as_str() {
        println!("  WARNING   from a DEVELOPMENT key — only development builds accept it");
    }
    println!();
    println!("Read this to the merchant — fifteen symbols in three groups:");
    println!();
    println!("    {}", issued.code);
    println!();
    println!("The merchant types it into Settings > Licensing > emergency code. Full operation returns");
    println!("at once, until the date above. It is not a licence: send a licence code when one can be received.");
    Ok(())
}

fn check_command(home: &Home, source: &PasswordSource) -> Result<(), String> {
    let file = load_key(home)?;
    let password = read_password("Password for the private key: ", source)?;
    let signing = open_key(&file, &password, source)?;
    println!("The key opens with this password.");
    println!("  folder       {}", home.path.display());
    println!("  kind         {}", file.kind);
    println!("  fingerprint  {}", key_fingerprint(&signing.verifying_key().to_bytes()));
    if let Some(chain) = file.unlock.as_ref().map(keystore::UnlockParams::chain).transpose()? {
        println!("  phone codes  until {}", date(chain.valid_until(chain.length)));
    }
    println!("Nothing was issued and nothing was written.");
    Ok(())
}

fn list_command(home: &Path, device: Option<String>) -> Result<(), String> {
    let connection = log::open(&home.join(LOG_FILE)).map_err(|e| format!("opening the log: {e}"))?;
    let device = device.map(|d| loyalty_pro_license::device::normalize_device_id(&d));
    let entries = log::list(&connection, device.as_deref()).map_err(|e| e.to_string())?;
    let unlocks = log::list_unlocks(&connection, device.as_deref()).map_err(|e| e.to_string())?;
    if entries.is_empty() && unlocks.is_empty() {
        println!("Nothing issued{}.", device.map(|d| format!(" to {d}")).unwrap_or_default());
        return Ok(());
    }
    if !unlocks.is_empty() {
        println!("Emergency codes");
        println!("{:<20}  {:<12}  {:<20}  {:<17}  note", "issued", "device", "works until", "code");
        for entry in &unlocks {
            println!(
                "{:<20}  {:<12}  {:<20}  {:<17}  {}",
                date(entry.issued_at),
                entry.device_id,
                date(entry.valid_until),
                entry.code,
                entry.note.clone().unwrap_or_default()
            );
        }
        println!();
    }
    if entries.is_empty() {
        return Ok(());
    }
    println!("Licences");
    println!("{:<20}  {:<12}  {:<9}  {:<20}  {:<26}  {:<36}  note", "issued", "device", "type", "expires", "features", "licence");
    for entry in entries {
        let kind = if entry.extended { format!("{}+ext", entry.kind) } else { entry.kind.clone() };
        println!(
            "{:<20}  {:<12}  {:<9}  {:<20}  {:<26}  {:<36}  {}",
            date(entry.issued_at),
            entry.device_id,
            kind,
            entry.expires_at.map(date).unwrap_or_else(|| "never".into()),
            entry.features,
            entry.license_id,
            entry.note.unwrap_or_default()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_sealed_behind_a_bom_opens_with_the_plain_password_and_no_other() {
        let signing = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let file = keystore::seal(&signing, "\u{FEFF}correct horse battery", KeyKind::Production, "now").unwrap();
        assert_eq!(open_key(&file, "correct horse battery", &PasswordSource::Prompt).unwrap().to_bytes(), signing.to_bytes());
        assert!(open_key(&file, "correct horse batterY", &PasswordSource::Prompt).is_err());
    }
}
