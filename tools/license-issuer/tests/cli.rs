//! The built program, driven the way a person drives it: the password delivered by file
//! and by pipe in the shapes real shells produce, and a renewal after a first licence.
//!
//! Uses a copy of the committed development key (password in dev-key/README.md), so it
//! signs nothing a shop accepts.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const DEV_PASSWORD: &str = "walaa-development-only-key";

fn dev_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let key = Path::new(env!("CARGO_MANIFEST_DIR")).join("dev-key").join("issuer-key.json");
    std::fs::copy(key, home.path().join("issuer-key.json")).unwrap();
    home
}

fn issuer(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_license-issuer"));
    command.arg("--home").arg(home);
    command
}

fn run_with_stdin(mut command: Command, input: &[u8]) -> Output {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn text(output: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))
}

fn password_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn the_password_arrives_intact_by_file_and_by_pipe_in_every_shape() {
    let home = dev_home();
    let utf16le_bom_crlf: Vec<u8> =
        [vec![0xFF, 0xFE], format!("{DEV_PASSWORD}\r\n").encode_utf16().flat_map(u16::to_le_bytes).collect()].concat();

    // File: UTF-8 with a byte-order mark and CRLF — Notepad, or PowerShell's Set-Content -Encoding UTF8.
    let file = password_file(home.path(), "bom-crlf.txt", format!("\u{FEFF}{DEV_PASSWORD}\r\n").as_bytes());
    let output = issuer(home.path())
        .arg("--password-file")
        .arg(&file)
        .args(["unlock", "--device", "WL-2222-2222", "--days", "1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "UTF-8 BOM file: {}", text(&output));

    // File: UTF-16LE with a byte-order mark — Windows PowerShell 5.1's `echo x > file`.
    let file = password_file(home.path(), "utf16.txt", &utf16le_bom_crlf);
    let output = issuer(home.path())
        .arg("--password-file")
        .arg(&file)
        .args(["unlock", "--device", "WL-2222-2222", "--days", "1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "UTF-16 file: {}", text(&output));

    // Pipe: the byte-order mark a PowerShell with UTF-8 output encoding sends, twice over.
    let mut command = issuer(home.path());
    command.args(["--password-stdin", "unlock", "--device", "WL-2222-2222", "--days", "1"]);
    let output = run_with_stdin(command, format!("\u{FEFF}\u{FEFF}  {DEV_PASSWORD} \r\n").as_bytes());
    assert!(output.status.success(), "BOM pipe: {}", text(&output));

    // Pipe: UTF-16.
    let mut command = issuer(home.path());
    command.args(["--password-stdin", "unlock", "--device", "WL-2222-2222", "--days", "1"]);
    let output = run_with_stdin(command, &utf16le_bom_crlf);
    assert!(output.status.success(), "UTF-16 pipe: {}", text(&output));

    // And a genuinely wrong password is still refused.
    let mut command = issuer(home.path());
    command.args(["--password-stdin", "unlock", "--device", "WL-2222-2222", "--days", "1"]);
    let output = run_with_stdin(command, b"walaa-development-only-kez\r\n");
    assert!(!output.status.success());
    assert!(text(&output).contains("wrong password"), "{}", text(&output));
}

#[test]
fn a_first_licence_is_issued_and_every_later_one_is_a_renewal() {
    let home = dev_home();
    let file = password_file(home.path(), "password.txt", DEV_PASSWORD.as_bytes());
    let run = |args: &[&str]| issuer(home.path()).arg("--password-file").arg(&file).args(args).output().unwrap();

    let renew_before_issue = run(&["renew", "--device", "WL-2345-6789", "--days", "30"]);
    assert!(!renew_before_issue.status.success());
    assert!(text(&renew_before_issue).contains("nothing to renew"), "{}", text(&renew_before_issue));

    let first = run(&["issue", "--device", "WL-2345-6789", "--days", "14", "--note", "test shop"]);
    assert!(first.status.success(), "{}", text(&first));

    let issue_again = run(&["issue", "--device", "WL-2345-6789", "--days", "30"]);
    assert!(!issue_again.status.success());
    assert!(text(&issue_again).contains("renew"), "{}", text(&issue_again));

    let renewed = run(&["renew", "--device", "WL-2345-6789", "--days", "30"]);
    let out = text(&renewed);
    assert!(renewed.status.success(), "{out}");
    assert!(out.contains("Licence renewed") && out.contains("still running") && out.contains("note      test shop"), "{out}");
    // The code is the last block printed, so scripts that take everything after the marker keep working.
    let code = out.split("Send the merchant this code (the lines can be pasted as they are):").nth(1).unwrap().trim();
    assert!(!code.is_empty() && code.lines().all(|line| !line.contains(' ')), "{code}");

    let paid = run(&["renew", "--device", "WL-2345-6789", "--perpetual"]);
    assert!(paid.status.success(), "{}", text(&paid));
    let after_paid = run(&["renew", "--device", "WL-2345-6789", "--days", "30"]);
    assert!(!after_paid.status.success());
    assert!(text(&after_paid).contains("perpetual"), "{}", text(&after_paid));
}

#[test]
fn a_missing_key_names_the_folders_it_looked_in() {
    let empty = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_license-issuer"))
        .env_remove("WALAA_ISSUER_HOME")
        .env("USERPROFILE", empty.path())
        .env("APPDATA", empty.path())
        .args(["--password-stdin", "unlock", "--device", "WL-2222-2222"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let out = text(&output);
    assert!(out.contains(".walaa-issuer") && out.contains("walaa-license-issuer"), "{out}");
}
