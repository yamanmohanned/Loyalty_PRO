//! The latest time this installation has observed, kept in three places — a database
//! table, `HKCU\Software\Walaa`, and a hidden file in the data folder — so that setting
//! the clock back is noticed even if one of them is deleted.
//!
//! This module resolves the three readings and keeps the file. The database is the
//! API's, and the registry is in `windows.rs`.

use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

const FILE_HEADER: &str = "walaa-clock-v1";

/// The three readings, reduced to one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    /// The latest recorded time — the most restrictive reading.
    pub latest: Option<i64>,
    /// The locations disagreed: a value differed, or one was missing while others were
    /// present. Written together, they only disagree after a failed write or an edit.
    pub conflict: bool,
}

pub fn resolve(readings: &[Option<i64>]) -> Resolution {
    let present: Vec<i64> = readings.iter().flatten().copied().collect();
    let latest = present.iter().copied().max();
    let conflict = !present.is_empty()
        && (present.len() != readings.len() || present.iter().any(|v| Some(*v) != latest));
    Resolution { latest, conflict }
}

/// Reads the file. A missing or unreadable file is "no reading", not an error: the
/// other two locations still count, and the disagreement is reported by `resolve`.
pub fn read_file(path: &Path) -> io::Result<Option<i64>> {
    let mut text = String::new();
    match OpenOptions::new().read(true).open(path) {
        Ok(mut file) => {
            file.read_to_string(&mut text)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut words = text.split_whitespace();
    if words.next() != Some(FILE_HEADER) {
        return Ok(None);
    }
    Ok(words.next().and_then(|w| w.parse::<i64>().ok()))
}

/// Writes the file and marks it hidden.
///
/// Opened without truncation and cut to length afterwards, on purpose: Windows refuses
/// to *create-over* a file that carries the hidden attribute unless the call asks for
/// that attribute too, so a plain `fs::write` succeeds once and fails every time after.
pub fn write_file(path: &Path, value: i64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(file, "{FILE_HEADER} {value}")?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    crate::windows::set_hidden(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agreement_is_not_a_conflict() {
        assert_eq!(resolve(&[Some(10), Some(10), Some(10)]), Resolution { latest: Some(10), conflict: false });
        assert_eq!(resolve(&[None, None, None]), Resolution { latest: None, conflict: false });
    }

    #[test]
    fn disagreement_takes_the_latest_and_says_so() {
        assert_eq!(resolve(&[Some(10), Some(50), Some(30)]), Resolution { latest: Some(50), conflict: true });
        // One location deleted — the other two still decide.
        assert_eq!(resolve(&[Some(40), None, Some(40)]), Resolution { latest: Some(40), conflict: true });
    }

    #[test]
    fn the_file_survives_being_rewritten_while_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".license-clock");
        assert_eq!(read_file(&path).unwrap(), None);
        write_file(&path, 1_700_000_000).unwrap();
        write_file(&path, 1_700_000_500).unwrap();
        assert_eq!(read_file(&path).unwrap(), Some(1_700_000_500));
    }

    #[test]
    fn a_garbled_file_is_no_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".license-clock");
        std::fs::write(&path, "nonsense").unwrap();
        assert_eq!(read_file(&path).unwrap(), None);
    }
}
