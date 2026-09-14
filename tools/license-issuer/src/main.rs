//! `license-issuer` — issues ولاء licence codes.
//!
//! Holds the only copy of the private key (encrypted, beside a log of every licence
//! issued). Never shipped with the application. See README.md before first use.

mod issue;
mod keystore;
mod log;

use std::io::{BufRead, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use chrono::{TimeZone, Utc};
use clap::{Parser, Subcommand};
use ed25519_dalek::Signer;
use walaa_license::{code, key_fingerprint, KeyKind};

const KEY_FILE: &str = "issuer-key.json";
const LOG_FILE: &str = "issued.db";

#[derive(Parser)]
#[command(name = "license-issuer", version, about = "Issues ولاء licence codes. Keep the key safe — see README.md.")]
struct Cli {
    /// Where the encrypted key and the log live. Default: %APPDATA%\walaa-license-issuer
    /// (or $WALAA_ISSUER_HOME).
    #[arg(long, global = true)]
    home: Option<PathBuf>,

    /// Read the password from the first line of standard input instead of prompting.
    /// For scripted use only; the prompt is the normal way.
    #[arg(long, global = true)]
    password_stdin: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate the key pair. Once. Refuses if a key already exists in --home.
    Keygen {
        /// Where to write the Rust source file carrying the public key. Default: the
        /// repository's crates/walaa-license/src/public_key.rs.
        #[arg(long)]
        public_key_out: Option<PathBuf>,
        /// Generate a development key: builds embedding it cannot be packaged.
        #[arg(long)]
        development: bool,
    },
    /// Issue a licence for a device.
    Issue {
        /// The device ID the merchant sent, WL-XXXX-XXXX.
        #[arg(long)]
        device: String,
        /// A trial of this many days.
        #[arg(long, conflicts_with = "perpetual", required_unless_present = "perpetual")]
        days: Option<u32>,
        /// A licence that never expires.
        #[arg(long)]
        perpetual: bool,
        /// Add the days to this device's latest trial expiry (from this log) instead of to now.
        #[arg(long, requires = "days")]
        extend: bool,
        /// Features to grant, comma-separated. Default: drive_backup,multi_device.
        #[arg(long, value_delimiter = ',')]
        feat: Option<Vec<String>>,
        /// Store name or any note, up to 120 characters. Travels inside the code.
        #[arg(long)]
        note: Option<String>,
    },
    /// List every licence this issuer has issued.
    List {
        /// Only this device.
        #[arg(long)]
        device: Option<String>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let home = cli.home.clone().unwrap_or_else(default_home);
    let result = match cli.command {
        Command::Keygen { public_key_out, development } => keygen(&home, cli.password_stdin, public_key_out, development),
        Command::Issue { device, days, perpetual, extend, feat, note } => {
            let term = if perpetual { issue::Term::Perpetual } else { issue::Term::Days(days.unwrap_or(0)) };
            issue_command(&home, cli.password_stdin, issue::Request { device, term, extend, features: feat, note })
        }
        Command::List { device } => list_command(&home, device),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn default_home() -> PathBuf {
    if let Ok(home) = std::env::var("WALAA_ISSUER_HOME") {
        return PathBuf::from(home);
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("walaa-license-issuer")
}

fn read_password(prompt: &str, from_stdin: bool) -> Result<String, String> {
    if from_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(|e| e.to_string())?;
        return Ok(line.trim_end_matches(['\r', '\n']).to_string());
    }
    if !std::io::stdin().is_terminal() {
        return Err("no terminal to prompt for the password — run this in a terminal, or pass --password-stdin".into());
    }
    rpassword::prompt_password(prompt).map_err(|e| e.to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn date(seconds: i64) -> String {
    Utc.timestamp_opt(seconds, 0).single().map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default()
}

fn keygen(home: &Path, from_stdin: bool, public_key_out: Option<PathBuf>, development: bool) -> Result<(), String> {
    let key_path = home.join(KEY_FILE);
    if key_path.exists() {
        return Err(format!(
            "{} already exists. keygen runs once: a new key would make every code already issued unverifiable by the next build. \
             Move the existing file away deliberately if you really mean to start again.",
            key_path.display()
        ));
    }

    let kind = if development { KeyKind::Development } else { KeyKind::Production };
    let password = read_password("New password for the private key: ", from_stdin)?;
    if !from_stdin {
        let again = read_password("Repeat the password: ", false)?;
        if again != password {
            return Err("the two passwords differ — nothing was written".into());
        }
    }
    let (file, signing) = keystore::generate(&password, kind, &now_iso())?;
    let public = signing.verifying_key().to_bytes();

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

    let written = match std::fs::write(&target, public_key_source(&public, kind)) {
        Ok(()) => format!("wrote the public key into {}", target.display()),
        Err(error) => format!(
            "could not write {} ({error}) — copy this into crates/walaa-license/src/public_key.rs by hand:\n\n{}",
            target.display(),
            public_key_source(&public, kind)
        ),
    };

    println!("Key pair generated ({}).", kind.as_str());
    println!("  private key (encrypted)  {}", key_path.display());
    println!("  issue log                {}", home.join(LOG_FILE).display());
    println!("  public key fingerprint   {}", key_fingerprint(&public));
    println!("  {written}");
    println!();
    println!("Back up the folder {} and the password NOW, in two separate places.", home.display());
    println!("Losing either one makes it impossible to issue any new licence — see README.md.");
    println!("Then rebuild the application so it embeds this public key.");
    Ok(())
}

fn default_public_key_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/walaa-license/src/public_key.rs")
}

fn rust_bytes(bytes: &[u8]) -> String {
    bytes
        .chunks(8)
        .map(|chunk| chunk.iter().map(|b| format!("0x{b:02x}")).collect::<Vec<_>>().join(", "))
        .collect::<Vec<_>>()
        .join(",\n    ")
}

fn public_key_source(public: &[u8; 32], kind: KeyKind) -> String {
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
         pub const PUBLIC_KEY: [u8; 32] = [\n    {},\n];\n",
        key_fingerprint(public),
        rust_bytes(public)
    )
}

fn load_key(home: &Path) -> Result<keystore::KeyFile, String> {
    let key_path = home.join(KEY_FILE);
    let text = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("reading {}: {e} — run `license-issuer keygen` first, or pass --home", key_path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not a key file: {e}", key_path.display()))
}

fn issue_command(home: &Path, from_stdin: bool, request: issue::Request) -> Result<(), String> {
    let file = load_key(home)?;
    let connection = log::open(&home.join(LOG_FILE)).map_err(|e| format!("opening the log: {e}"))?;

    let device = walaa_license::device::normalize_device_id(&request.device);
    let previous = log::latest_trial_expiry(&connection, &device).map_err(|e| e.to_string())?;
    let now = Utc::now().timestamp();
    let payload = issue::build(&request, now, previous, uuid::Uuid::new_v4().to_string())?;

    let password = read_password("Password for the private key: ", from_stdin)?;
    let signing = keystore::open(&file, &password)?;
    let bytes = payload.to_bytes();
    let signature = signing.sign(&bytes).to_bytes();
    let license_code = code::encode(&bytes, &signature);

    // Proves the code before it is handed out: the same check the application makes.
    let public = signing.verifying_key().to_bytes();
    walaa_license::verify_with_key(&license_code, &payload.did, &public)
        .map_err(|e| format!("internal error: the new code does not verify ({})", e.code()))?;

    log::record(&connection, &payload, request.extend, &file.fingerprint, &license_code)
        .map_err(|e| format!("recording in the log: {e}"))?;

    println!("Licence issued");
    println!("  device    {}", payload.did);
    match payload.exp {
        None => println!("  type      perpetual — never expires"),
        Some(exp) => println!(
            "  type      trial{} — until {}",
            if request.extend { " (extension)" } else { "" },
            date(exp)
        ),
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
    println!("Send the merchant this code (the lines can be pasted as they are):");
    println!();
    println!("{}", code::wrap(&license_code));
    Ok(())
}

fn list_command(home: &Path, device: Option<String>) -> Result<(), String> {
    let connection = log::open(&home.join(LOG_FILE)).map_err(|e| format!("opening the log: {e}"))?;
    let device = device.map(|d| walaa_license::device::normalize_device_id(&d));
    let entries = log::list(&connection, device.as_deref()).map_err(|e| e.to_string())?;
    if entries.is_empty() {
        println!("No licences issued{}.", device.map(|d| format!(" to {d}")).unwrap_or_default());
        return Ok(());
    }
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
