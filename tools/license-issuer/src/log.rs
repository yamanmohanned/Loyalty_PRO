//! The issuer's own record of every licence it has issued — local SQLite, beside the key.

use rusqlite::{params, Connection};
use std::path::Path;
use loyalty_pro_license::Payload;

pub struct Entry {
    pub license_id: String,
    pub device_id: String,
    pub kind: String,
    pub issued_at: i64,
    pub expires_at: Option<i64>,
    pub features: String,
    pub note: Option<String>,
    pub extended: bool,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    migrate(&connection)?;
    Ok(connection)
}

pub fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS issued (
            id INTEGER PRIMARY KEY,
            license_id TEXT NOT NULL UNIQUE,
            device_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            issued_at INTEGER NOT NULL,
            expires_at INTEGER,
            features TEXT NOT NULL,
            note TEXT,
            extended INTEGER NOT NULL DEFAULT 0,
            key_fingerprint TEXT NOT NULL,
            code TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS issued_device ON issued(device_id, issued_at);
        CREATE TABLE IF NOT EXISTS unlocks (
            id INTEGER PRIMARY KEY,
            device_id TEXT NOT NULL,
            day INTEGER NOT NULL,
            valid_until INTEGER NOT NULL,
            issued_at INTEGER NOT NULL,
            note TEXT,
            key_fingerprint TEXT NOT NULL,
            code TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS unlocks_device ON unlocks(device_id, issued_at);",
    )
}

pub struct UnlockEntry {
    pub device_id: String,
    pub issued_at: i64,
    pub valid_until: i64,
    pub note: Option<String>,
    pub code: String,
}

pub fn record_unlock(
    connection: &Connection,
    device: &str,
    issued: &loyalty_pro_license::unlock::Issued,
    issued_at: i64,
    note: Option<&str>,
    fingerprint: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO unlocks (device_id, day, valid_until, issued_at, note, key_fingerprint, code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![device, issued.day, issued.valid_until, issued_at, note, fingerprint, issued.code],
    )?;
    Ok(())
}

pub fn list_unlocks(connection: &Connection, device: Option<&str>) -> rusqlite::Result<Vec<UnlockEntry>> {
    let mut statement = connection.prepare(
        "SELECT device_id, issued_at, valid_until, note, code
         FROM unlocks WHERE (?1 IS NULL OR device_id = ?1) ORDER BY issued_at, id",
    )?;
    let rows = statement.query_map(params![device], |row| {
        Ok(UnlockEntry {
            device_id: row.get(0)?,
            issued_at: row.get(1)?,
            valid_until: row.get(2)?,
            note: row.get(3)?,
            code: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn record(connection: &Connection, payload: &Payload, extended: bool, fingerprint: &str, code: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO issued (license_id, device_id, kind, issued_at, expires_at, features, note, extended, key_fingerprint, code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            payload.lid,
            payload.did,
            payload.kind.as_str(),
            payload.iat,
            payload.exp,
            payload.feat.join(","),
            payload.note,
            extended,
            fingerprint,
            code
        ],
    )?;
    Ok(())
}

pub fn list(connection: &Connection, device: Option<&str>) -> rusqlite::Result<Vec<Entry>> {
    let mut statement = connection.prepare(
        "SELECT license_id, device_id, kind, issued_at, expires_at, features, note, extended
         FROM issued WHERE (?1 IS NULL OR device_id = ?1) ORDER BY issued_at, id",
    )?;
    let rows = statement.query_map(params![device], |row| {
        Ok(Entry {
            license_id: row.get(0)?,
            device_id: row.get(1)?,
            kind: row.get(2)?,
            issued_at: row.get(3)?,
            expires_at: row.get(4)?,
            features: row.get(5)?,
            note: row.get(6)?,
            extended: row.get(7)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use loyalty_pro_license::LicenseKind;

    fn payload(lid: &str, exp: Option<i64>) -> Payload {
        Payload {
            v: 1,
            lid: lid.into(),
            did: "WL-2345-6789".into(),
            kind: if exp.is_some() { LicenseKind::Trial } else { LicenseKind::Perpetual },
            iat: 100,
            exp,
            feat: vec!["drive_backup".into()],
            note: None,
        }
    }

    #[test]
    fn records_lists_and_summarises_what_a_device_holds() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        record(&connection, &payload("a", Some(1_000)), false, "FP", "code-a").unwrap();
        record(&connection, &payload("b", Some(5_000)), true, "FP", "code-b").unwrap();
        record(&connection, &payload("c", None), false, "FP", "code-c").unwrap();

        let current = crate::issue::Current::from_entries(&list(&connection, Some("WL-2345-6789")).unwrap()).unwrap();
        assert_eq!(current.trial_until, Some(5_000));
        assert_eq!(current.perpetual_since, Some(100));
        assert!(crate::issue::Current::from_entries(&list(&connection, Some("WL-9999-9999")).unwrap()).is_none());
        assert_eq!(list(&connection, None).unwrap().len(), 3);
        assert_eq!(list(&connection, Some("WL-9999-9999")).unwrap().len(), 0);
        // The same licence id twice is refused by the database.
        assert!(record(&connection, &payload("a", Some(1_000)), false, "FP", "code-a").is_err());
    }

    #[test]
    fn records_and_lists_emergency_codes() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let issued = loyalty_pro_license::unlock::Issued { code: "ABCDE-FGHJK-MNPQR".into(), day: 5, valid_until: 9_000 };
        record_unlock(&connection, "WL-2345-6789", &issued, 1_000, Some("drive died"), "FP").unwrap();
        let listed = list_unlocks(&connection, Some("WL-2345-6789")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].valid_until, 9_000);
        assert_eq!(listed[0].note.as_deref(), Some("drive died"));
        assert!(list_unlocks(&connection, Some("WL-9999-9999")).unwrap().is_empty());
    }
}
