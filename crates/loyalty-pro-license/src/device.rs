//! The device ID: `WL-XXXX-XXXX`, from the Windows MachineGuid and the system drive's
//! volume serial.
//!
//! ## Why the alphabet has 30 symbols, not 32
//!
//! The spec asks for Base32 without `I`, `L`, `O`, `U`, `0` and `1`. Letters A–Z and
//! digits 0–9 minus those six leave 30 symbols, so a true Base32 is not possible. The
//! ID is therefore eight digits in base 30 over exactly those 30 symbols, taken from
//! the SHA-256 of the two sources — the same property the spec wants (nothing a person
//! reading it over the phone can confuse), with about 39 bits instead of 40.

use sha2::{Digest, Sha256};

/// The 30 unambiguous symbols: digits 2–9 and letters without I, L, O, U.
pub const ALPHABET: &[u8; 30] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

const DIGITS: usize = 8;

/// The device ID for these two sources.
///
/// The GUID is compared case-insensitively and trimmed, and the serial is taken as the
/// eight hex digits `vol` prints, so the same machine always yields the same ID.
pub fn device_id(machine_guid: &str, volume_serial: u32) -> String {
    let material = format!(
        "walaa-device-v1|{}|{:08X}",
        machine_guid.trim().to_ascii_lowercase(),
        volume_serial
    );
    let digest = Sha256::digest(material.as_bytes());
    let head = u64::from_be_bytes(digest[..8].try_into().expect("a SHA-256 has 32 bytes"));

    let base = ALPHABET.len() as u64;
    let mut n = head % base.pow(DIGITS as u32);
    let mut symbols = [0u8; DIGITS];
    for slot in symbols.iter_mut().rev() {
        *slot = ALPHABET[(n % base) as usize];
        n /= base;
    }
    let text = std::str::from_utf8(&symbols).expect("the alphabet is ASCII");
    format!("WL-{}-{}", &text[..4], &text[4..])
}

/// A device ID as typed or pasted, tidied: upper case, surrounding spaces gone.
pub fn normalize_device_id(input: &str) -> String {
    input.trim().to_ascii_uppercase()
}

/// Whether `id` has the shape of a device ID and uses only the 30 symbols.
pub fn is_valid_device_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 12
        && id.starts_with("WL-")
        && bytes[7] == b'-'
        && bytes[3..7].iter().chain(&bytes[8..]).all(|b| ALPHABET.contains(b))
}

/// A one-way fingerprint of one source, stored so a later change can be named
/// ("the drive was replaced") without storing the GUID or the serial themselves.
pub fn source_digest(label: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("walaa-device-source-v1|{label}|{value}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_stable_and_well_formed() {
        let id = device_id("4c4c4544-0042-3510-8052-b4c04f4d4a32", 0x1A2B_3C4D);
        assert_eq!(id, device_id("  4C4C4544-0042-3510-8052-B4C04F4D4A32 ", 0x1A2B_3C4D));
        assert!(is_valid_device_id(&id), "{id}");
    }

    #[test]
    fn never_uses_an_ambiguous_symbol() {
        for serial in 0..2000u32 {
            let id = device_id("guid", serial);
            assert!(!id[3..].chars().any(|c| "ILOU01".contains(c)), "{id}");
            assert!(is_valid_device_id(&id));
        }
    }

    #[test]
    fn changes_when_either_source_changes() {
        let base = device_id("guid-a", 1);
        assert_ne!(base, device_id("guid-b", 1));
        assert_ne!(base, device_id("guid-a", 2));
    }

    #[test]
    fn rejects_malformed_ids() {
        assert!(!is_valid_device_id("WL-ABCD-EFG"));
        assert!(!is_valid_device_id("XX-ABCD-EFGH"));
        assert!(!is_valid_device_id("WL-ABCD-EFG1"));
        assert!(!is_valid_device_id("WL-ABCDXEFGH"));
        assert!(!is_valid_device_id("wl-abcd-efgh"));
        assert!(is_valid_device_id(&normalize_device_id(" wl-abcd-efgh ")));
    }
}
